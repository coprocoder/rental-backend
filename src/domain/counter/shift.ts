/**
 * Смена: группировка операций, а не пропускной пункт.
 *
 * Зачем (../rental-docs/docs/04-тз/10-бэкенд/24-смена-и-ревизия.md): наличные — основной
 * способ оплаты, и без смены остаются без ответа три вопроса — сколько
 * денег должно быть в ящике, что унаследовал вечерний сотрудник от
 * утреннего, в чью смену возникло расхождение. `audit_log` отвечает
 * «кто сделал», но не «в чью смену», а при разборе недостачи нужно
 * именно второе.
 *
 * ⚠️ Почему это делается до интерфейса: привязку операций к смене
 * задним числом восстановить НЕЛЬЗЯ. Прошедший сезон останется без
 * этих данных навсегда — тот же аргумент, что для demand_daily.
 *
 * ⚠️ Смена НЕ обязательна. Требовать её открытия — значит нарушить
 * правило «система работает при небрежном учёте»: в пик никто не будет
 * открывать смену, и операции просто останутся без привязки. Поэтому
 * при отсутствии открытой создаётся НЕЯВНАЯ на филиал и день — ровно
 * как заказ «с улицы» создаётся задним числом.
 */
import type { PoolClient } from 'pg'

/**
 * Возвращает смену для операции, создавая неявную при необходимости.
 *
 * ⚠️ Идемпотентно по (филиал, локальный день): два одновременных вызова
 * не должны создать две неявные смены, иначе операции одного дня
 * разъедутся по двум группам и сверка кассы потеряет смысл.
 */
export async function currentShift(
  c: PoolClient,
  opts: { tenantId: string, branchId: string, staffId?: string },
): Promise<{ id: string, isImplicit: boolean }> {
  // Сначала — открытая смена филиала.
  const { rows: open } = await c.query<{ id: string, is_implicit: boolean }>(
    `SELECT id, is_implicit FROM shift
     WHERE tenant_id = $1 AND branch_id = $2 AND closed_at IS NULL
     ORDER BY opened_at DESC
     LIMIT 1`,
    [opts.tenantId, opts.branchId],
  )
  if (open[0]) return { id: open[0].id, isImplicit: open[0].is_implicit }

  // Открытой нет — неявная на текущий локальный день филиала.
  // ⚠️ День считается по поясу ФИЛИАЛА: смена «на сегодня» в
  // Красноярске не должна закрываться по московской полуночи.
  const { rows: created } = await c.query<{ id: string, is_implicit: boolean }>(
    `WITH existing AS (
       SELECT s.id, s.is_implicit
       FROM shift s
       JOIN branch b ON b.id = s.branch_id
       WHERE s.tenant_id = $1 AND s.branch_id = $2 AND s.is_implicit
         AND (s.opened_at AT TIME ZONE b.timezone)::date
             = (now() AT TIME ZONE b.timezone)::date
       LIMIT 1
     ), inserted AS (
       INSERT INTO shift (tenant_id, branch_id, opened_by, is_implicit, note)
       SELECT $1, $2, $3, true, 'создана системой: смена не была открыта'
       WHERE NOT EXISTS (SELECT 1 FROM existing)
       RETURNING id, is_implicit
     )
     SELECT id, is_implicit FROM inserted
     UNION ALL SELECT id, is_implicit FROM existing
     LIMIT 1`,
    [opts.tenantId, opts.branchId, opts.staffId ?? null],
  )

  return { id: created[0]!.id, isImplicit: created[0]!.is_implicit }
}

/**
 * Открывает смену явно — с суммой в ящике на начало.
 *
 * ⚠️ Если неявная смена на этот день уже есть, она НЕ дублируется, а
 * превращается в явную: иначе утренние операции остались бы в неявной
 * смене, а сверка кассы считалась бы по явной, и недостача выглядела
 * бы больше, чем есть.
 */
export async function openShift(
  c: PoolClient,
  opts: { tenantId: string, branchId: string, staffId: string, cashOpen?: string },
): Promise<{ id: string, adopted: boolean }> {
  const existing = await c.query<{ id: string, is_implicit: boolean }>(
    `SELECT id, is_implicit FROM shift
     WHERE tenant_id = $1 AND branch_id = $2 AND closed_at IS NULL
     ORDER BY opened_at DESC LIMIT 1`,
    [opts.tenantId, opts.branchId],
  )

  const row = existing.rows[0]
  if (row?.is_implicit) {
    await c.query(
      `UPDATE shift
       SET is_implicit = false, opened_by = $2, cash_open = $3,
           note = COALESCE(note, '') || ' · смена открыта сотрудником'
       WHERE id = $1`,
      [row.id, opts.staffId, opts.cashOpen ?? null],
    )
    return { id: row.id, adopted: true }
  }
  if (row) return { id: row.id, adopted: false }

  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO shift (tenant_id, branch_id, opened_by, cash_open)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [opts.tenantId, opts.branchId, opts.staffId, opts.cashOpen ?? null],
  )
  return { id: rows[0]!.id, adopted: false }
}

export interface ShiftSummary {
  id: string
  openedAt: Date
  isImplicit: boolean
  issued: number
  returned: number
  /** Незакрытые выдачи — то, что вечерний сотрудник наследует. */
  outstanding: number
  overdue: number
  cashOpen: string | null
}

/**
 * Сводка смены — основа передачи.
 *
 * ⚠️ Незакрытые выдачи и просрочки показываются отдельно: смысл
 * передачи смены в том, чтобы вечерний сотрудник увидел, что осталось
 * от утреннего, а не только итоговые числа.
 */
export async function shiftSummary(
  c: PoolClient,
  shiftId: string,
): Promise<ShiftSummary | null> {
  const { rows } = await c.query<{
    id: string
    opened_at: Date
    is_implicit: boolean
    cash_open: string | null
    branch_id: string
  }>(
    `SELECT id, opened_at, is_implicit, cash_open, branch_id
     FROM shift WHERE id = $1`,
    [shiftId],
  )
  const s = rows[0]
  if (!s) return null

  const { rows: counts } = await c.query<{
    issued: number
    returned: number
  }>(
    `SELECT
       count(*) FILTER (WHERE kind = 'issue')::int AS issued,
       count(*) FILTER (WHERE kind = 'return')::int AS returned
     FROM movement WHERE shift_id = $1`,
    [shiftId],
  )

  // Незакрытое считается по ФИЛИАЛУ, а не по смене: клиент мог взять
  // утром и не вернуть — это наследство вечернего сотрудника,
  // независимо от того, в какую смену была выдача.
  const { rows: open } = await c.query<{ outstanding: number, overdue: number }>(
    `SELECT
       count(*) FILTER (WHERE status IN ('issued', 'partially_returned'))::int
         AS outstanding,
       count(*) FILTER (WHERE status = 'overdue')::int AS overdue
     FROM rental_order
     WHERE branch_pickup_id = $1`,
    [s.branch_id],
  )

  return {
    id: s.id,
    openedAt: s.opened_at,
    isImplicit: s.is_implicit,
    issued: counts[0]?.issued ?? 0,
    returned: counts[0]?.returned ?? 0,
    outstanding: open[0]?.outstanding ?? 0,
    overdue: open[0]?.overdue ?? 0,
    cashOpen: s.cash_open,
  }
}

/** Закрывает смену с суммой в ящике на конец. */
export async function closeShift(
  c: PoolClient,
  opts: { shiftId: string, staffId: string, cashClose?: string, note?: string },
): Promise<void> {
  await c.query(
    `UPDATE shift
     SET closed_at = now(), closed_by = $2, cash_close = $3,
         note = CASE WHEN $4::text IS NULL THEN note
                     ELSE COALESCE(note || ' · ', '') || $4 END
     WHERE id = $1 AND closed_at IS NULL`,
    [opts.shiftId, opts.staffId, opts.cashClose ?? null, opts.note ?? null],
  )
}

/* ─────────────────── сводка дня и касса (17.15) ─────────────────── */

export interface DaySummary {
  /** Выручка по заказам, выданным в эту смену. */
  revenue: string
  orders: number
  issued: number
  returned: number
  /** Ожидаемая касса: остаток на открытие плюс выручка. */
  cashExpected: string | null
  cashOpen: string | null
  /** Расхождение факта с ожиданием; null — факт ещё не введён. */
  cashDiff: string | null
  /** Что случилось за смену — для передачи, а не для отчёта. */
  incidents: { kind: string, at: Date, note: string | null }[]
}

/**
 * Сводка смены с подсчётом кассы (17.15).
 *
 * ⚠️ Касса считается КАК ОЖИДАНИЕ, а не как истина: система не знает
 * о размене, инкассации и оплате картой мимо неё. Поэтому отдаётся
 * пара «ожидали / фактически» и разница — решение о том, что с ней
 * делать, принимает человек. Показать одно число и назвать его кассой
 * значило бы обвинить сотрудника в недостаче, которой может не быть.
 *
 * ⚠️ Выручка считается по заказам, ВЫДАННЫМ в эту смену, а не
 * созданным: деньги берут при выдаче, и заказ, оформленный вчера
 * онлайн, попадает в кассу того дня, когда за ним пришли.
 */
export async function daySummary(
  c: PoolClient,
  shiftId: string,
): Promise<DaySummary | null> {
  const { rows: sh } = await c.query<{
    cash_open: string | null
    branch_id: string
    opened_at: Date
    closed_at: Date | null
  }>(
    `SELECT cash_open, branch_id, opened_at, closed_at FROM shift WHERE id = $1`,
    [shiftId],
  )
  const s = sh[0]
  if (!s) return null

  const { rows: rev } = await c.query<{ revenue: string, orders: number }>(
    `SELECT COALESCE(SUM(o.total_amount), 0)::text AS revenue,
            count(DISTINCT o.id)::int AS orders
     FROM rental_order o
     WHERE o.shift_id = $1
       AND o.status IN ('issued', 'partially_returned', 'returned', 'overdue')`,
    [shiftId],
  )

  const { rows: mv } = await c.query<{ issued: number, returned: number }>(
    `SELECT count(*) FILTER (WHERE kind = 'issue')::int  AS issued,
            count(*) FILTER (WHERE kind = 'return')::int AS returned
     FROM movement WHERE shift_id = $1`,
    [shiftId],
  )

  // Происшествия смены: списания и обслуживание с причиной — то, что
  // вечерний сотрудник обязан узнать, не читая журнал целиком.
  const { rows: inc } = await c.query<{ kind: string, at: Date, note: string | null }>(
    `SELECT kind::text, occurred_at AS at, reason AS note
     FROM movement
     WHERE shift_id = $1 AND kind IN ('write_off', 'to_service')
     ORDER BY occurred_at DESC LIMIT 20`,
    [shiftId],
  )

  const revenue = rev[0]?.revenue ?? '0'

  // ⚠️ Арифметика по деньгам — в SQL (numeric), а не в JS: сложение
  // строк через Number дало бы двоичную плавающую точку там, где
  // владелец сверяет с наличными в ящике.
  let cashExpected: string | null = null
  if (s.cash_open !== null) {
    const { rows: e } = await c.query<{ v: string }>(
      `SELECT ($1::numeric + $2::numeric)::text AS v`, [s.cash_open, revenue],
    )
    cashExpected = e[0]?.v ?? null
  }

  const { rows: cc } = await c.query<{ cash_close: string | null }>(
    `SELECT cash_close FROM shift WHERE id = $1`, [shiftId],
  )
  let cashDiff: string | null = null
  if (cashExpected !== null && cc[0]?.cash_close != null) {
    const { rows: d } = await c.query<{ v: string }>(
      `SELECT ($1::numeric - $2::numeric)::text AS v`, [cc[0].cash_close, cashExpected],
    )
    cashDiff = d[0]?.v ?? null
  }

  return {
    revenue,
    orders: rev[0]?.orders ?? 0,
    issued: mv[0]?.issued ?? 0,
    returned: mv[0]?.returned ?? 0,
    cashOpen: s.cash_open,
    cashExpected,
    cashDiff,
    incidents: inc,
  }
}
