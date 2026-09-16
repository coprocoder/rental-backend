/**
 * Ревизия и обслуживание.
 *
 * Зачем сезонный режим (../rental-docs/docs/04-тз/10-бэкенд/24-смена-и-ревизия.md): в сезон
 * инвентаризация идёт непрерывно — каждый возврат подтверждает наличие.
 * Но прокат открывается в ноябре с инвентарём, не тронутым с апреля,
 * и там нужен полный пересчёт.
 *
 * ⚠️ Всё считается из существующего журнала движений — новых сущностей
 * не нужно. Единственное, что должно быть заведено заранее, это
 * movement.service_kind: без него «поточили» и «сломано крепление»
 * навсегда неразличимы, а задним числом причину не восстановить.
 *
 * Ценность для удержания: режим попадает в межсезонье — момент, когда
 * прокат решает, продлевать ли подписку. Система, которая в ноябре
 * говорит «вот 12 бордов, которые ждут заточки, и 3 вещи, пропавшие
 * за лето», перестаёт быть сервисом бронирования.
 */
import type { PoolClient } from 'pg'
import { audit } from '../core/order-lifecycle'

export interface StocktakeRow {
  variantId: string
  variantName: string
  categoryCode: string
  /** Сколько должно быть по журналу движений. */
  expected: number
  /** Сколько в обслуживании — выдать нельзя, но вещь существует. */
  inService: number
}

/**
 * Ведомость пересчёта по категории.
 *
 * ⚠️ Показывает ожидаемое количество, но НЕ требует совпадения:
 * расхождение — это результат ревизии, а не ошибка ввода. Задача
 * системы делать расхождения видимыми, а не запрещать реальность
 * (железное правило №12).
 */
export async function stocktakeSheet(
  c: PoolClient,
  opts: { tenantId: string, branchId: string, categoryCode?: string },
): Promise<StocktakeRow[]> {
  const { rows } = await c.query<{
    variant_id: string
    variant_name: { ru?: string }
    category_code: string
    expected: string
    in_service: string
  }>(
    `SELECT v.id AS variant_id, v.name AS variant_name, cat.code AS category_code,
            COALESCE(SUM(m.qty), 0)::text AS expected,
            -- ⚠️ Знаки: to_service записан как -qty (вещь ушла из
            -- оборота), from_service как +qty (вернулась). Значит
            -- «сейчас в обслуживании» — это МИНУС сумма этих движений.
            COALESCE(-SUM(CASE
              WHEN m.kind IN ('to_service', 'from_service') THEN m.qty
              ELSE 0 END), 0)::text AS in_service
     FROM inventory_variant v
     JOIN category cat ON cat.id = v.category_id
     LEFT JOIN movement m ON m.variant_id = v.id AND m.branch_id = $2
     WHERE v.tenant_id = $1 AND v.branch_id = $2 AND v.archived_at IS NULL
       AND ($3::text IS NULL OR cat.code = $3)
     GROUP BY v.id, v.name, cat.code, cat.sort_order, v.sort_order
     ORDER BY cat.sort_order, v.sort_order`,
    [opts.tenantId, opts.branchId, opts.categoryCode ?? null],
  )

  return rows.map((r) => ({
    variantId: r.variant_id,
    variantName: r.variant_name?.ru ?? 'Позиция',
    categoryCode: r.category_code,
    expected: Number(r.expected),
    inService: Number(r.in_service),
  }))
}

/**
 * Применяет результат пересчёта.
 *
 * ⚠️ Записывается движением kind = 'stocktake' на РАЗНИЦУ, а не
 * перезаписью количества: физическое наличие — это сумма журнала, и
 * затирание истории лишило бы смысла всю модель. Плюс по журналу
 * потом видно, что расхождение было и кто его закрыл.
 */
export async function applyStocktake(
  c: PoolClient,
  opts: {
    tenantId: string
    branchId: string
    staffId: string
    shiftId?: string
    counted: { variantId: string, actual: number }[]
    reason?: string
  },
): Promise<{ adjustments: { variantId: string, delta: number }[] }> {
  const adjustments: { variantId: string, delta: number }[] = []

  for (const item of opts.counted) {
    const { rows } = await c.query<{ expected: string }>(
      `SELECT COALESCE(SUM(qty), 0)::text AS expected
       FROM movement
       WHERE tenant_id = $1 AND variant_id = $2 AND branch_id = $3`,
      [opts.tenantId, item.variantId, opts.branchId],
    )
    const expected = Number(rows[0]?.expected ?? 0)
    const delta = item.actual - expected

    // Совпало — движение не нужно: пустая запись только зашумит журнал.
    if (delta === 0) continue

    await c.query(
      `INSERT INTO movement
         (tenant_id, branch_id, variant_id, kind, qty, staff_id, shift_id, reason)
       VALUES ($1, $2, $3, 'stocktake', $4, $5, $6, $7)`,
      [opts.tenantId, opts.branchId, item.variantId, delta,
       opts.staffId, opts.shiftId ?? null,
       opts.reason ?? `ревизия: по журналу ${expected}, фактически ${item.actual}`],
    )

    adjustments.push({ variantId: item.variantId, delta })
  }

  // Ревизия — ручное вмешательство в наличие, значит в audit_log.
  if (adjustments.length) {
    await audit(c, {
      tenantId: opts.tenantId,
      staffId: opts.staffId,
      action: 'inventory.stocktake',
      targetType: 'branch',
      targetId: opts.branchId,
      reason: opts.reason,
      after: { adjustments },
    })
  }

  return { adjustments }
}

export interface StuckInServiceRow {
  variantId: string
  variantName: string
  qty: number
  serviceKind: string | null
  since: Date
  days: number
}

/**
 * Что лежит в обслуживании дольше N дней.
 *
 * ⚠️ Это про забытое, а не про текущее: вещь, ушедшая в ремонт в
 * апреле и «найденная» в ноябре — типичный случай, ради которого
 * режим и нужен. Поэтому порог по умолчанию большой.
 */
export async function stuckInService(
  c: PoolClient,
  opts: { tenantId: string, branchId?: string, days?: number },
): Promise<StuckInServiceRow[]> {
  const threshold = opts.days ?? 14

  const { rows } = await c.query<{
    variant_id: string
    variant_name: { ru?: string }
    qty: string
    service_kind: string | null
    since: Date
    days: string
  }>(
    `WITH service AS (
       SELECT variant_id,
              -- to_service отрицательное, from_service положительное,
              -- поэтому «сейчас в обслуживании» — минус их сумма.
              -SUM(qty) AS qty,
              MAX(service_kind) FILTER (WHERE kind = 'to_service') AS service_kind,
              MIN(occurred_at) FILTER (WHERE kind = 'to_service') AS since
       FROM movement
       WHERE tenant_id = $1
         AND ($2::uuid IS NULL OR branch_id = $2)
         AND kind IN ('to_service', 'from_service')
       GROUP BY variant_id
     )
     SELECT s.variant_id, v.name AS variant_name, s.qty::text,
            s.service_kind, s.since,
            EXTRACT(DAY FROM now() - s.since)::text AS days
     FROM service s
     JOIN inventory_variant v ON v.id = s.variant_id
     WHERE s.qty > 0
       AND s.since <= now() - ($3 || ' days')::interval
     ORDER BY s.since`,
    [opts.tenantId, opts.branchId ?? null, threshold],
  )

  return rows.map((r) => ({
    variantId: r.variant_id,
    variantName: r.variant_name?.ru ?? 'Позиция',
    qty: Number(r.qty),
    serviceKind: r.service_kind,
    since: r.since,
    days: Number(r.days),
  }))
}

/** Возвращает вещь из обслуживания в оборот. */
export async function returnFromService(
  c: PoolClient,
  opts: {
    tenantId: string
    branchId: string
    variantId: string
    qty: number
    staffId: string
    shiftId?: string
    serviceKind?: string
  },
): Promise<void> {
  await c.query(
    `INSERT INTO movement
       (tenant_id, branch_id, variant_id, kind, qty, staff_id, shift_id,
        service_kind, reason)
     VALUES ($1, $2, $3, 'from_service', $4, $5, $6, $7, 'обслуживание завершено')`,
    [opts.tenantId, opts.branchId, opts.variantId, opts.qty,
     opts.staffId, opts.shiftId ?? null, opts.serviceKind ?? null],
  )
}

export interface PoolDriftRow {
  variantId: string
  code: string
  /** Что говорит счётчик пула. */
  capacity: number
  /** Что говорит журнал движений — физическое наличие. */
  physical: number
  drift: number
}

/**
 * Расхождение счётчика пула с журналом движений.
 *
 * ⚠️ Только для позиций по КОЛИЧЕСТВУ: при поимённом учёте ёмкость
 * считается по единицам, и `pool_day` там не читается вовсе.
 *
 * ⚠️ Зачем: `capacity` правят шесть разных мест, и разойтись с
 * реальностью он может молча. На стенде так и вышло — витрина
 * недопродавала половину парка и не сообщала об этом. Расхождение
 * надо ПОКАЗЫВАТЬ, а не копить: физическое наличие — сумма журнала
 * (железное правило 2), и счётчик обязан за ней следовать.
 */
export async function poolDrift(
  c: PoolClient,
  opts: { tenantId: string, branchIds?: string[] },
): Promise<PoolDriftRow[]> {
  const scoped = (opts.branchIds?.length ?? 0) > 0

  const { rows } = await c.query<{
    variant_id: string, code: string, capacity: string, physical: string
  }>(
    `SELECT v.id AS variant_id, v.code,
            COALESCE((SELECT pd.capacity FROM pool_day pd
                       WHERE pd.variant_id = v.id AND pd.day = current_date), 0)::text AS capacity,
            COALESCE((SELECT SUM(m.qty) FROM movement m
                       WHERE m.variant_id = v.id AND m.branch_id = v.branch_id), 0)::text AS physical
       FROM inventory_variant v
       JOIN category cat ON cat.id = v.category_id
      WHERE v.tenant_id = $1
        AND v.archived_at IS NULL
        AND cat.tracking = 'count'
        AND cat.code <> 'service'
        AND (NOT $2 OR v.branch_id = ANY($3::uuid[]))`,
    [opts.tenantId, scoped, opts.branchIds ?? []],
  )

  return rows
    .map((r) => ({
      variantId: r.variant_id,
      code: r.code,
      capacity: Number(r.capacity),
      physical: Number(r.physical),
      drift: Number(r.capacity) - Number(r.physical),
    }))
    .filter((r) => r.drift !== 0)
}
