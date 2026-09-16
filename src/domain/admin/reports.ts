/**
 * Отчёты владельца (13.19).
 *
 * ⚠️ Все отчёты считаются ТОЛЬКО ПО ДНЯМ В СЕЗОНЕ категории. Это не
 * деталь: сапборды зимой дают «ёмкость есть, броней ноль» — то есть
 * загрузку 0% при исправном складе, — и отчёт советует «продать часть»
 * инвентаря, который просто ждёт лета. Тот же перекос в выручке
 * и в мёртвом стоке. Двойник условия живёт в SQL-функции
 * `season_month_active()` (миграция 0011), и тест сверяет её
 * с TS-версией на всех комбинациях.
 *
 * ⚠️ Деньги считаются в `numeric` и отдаются СТРОКОЙ (железное правило
 * №3). Ни одна сумма здесь не превращается в JS-число: на выручке за
 * сезон двоичная плавающая точка даёт расхождение, которое владелец
 * заметит при сверке с кассой.
 *
 * ⚠️ Отчёты — это ИНСТРУМЕНТ РЕШЕНИЯ, а не витрина цифр. Поэтому
 * у каждого есть подсказка «что с этим делать»: загрузка без порога
 * не говорит ничего, а «загрузка 12% при ёмкости 40 — половина парка
 * не окупается» говорит.
 */
import type { PoolClient } from 'pg'
import { localized, type I18nField } from '~/common/utils/i18n-field'

export interface Period { from: string, to: string }

/* ───────────────────────── загрузка ───────────────────────── */

export interface UtilizationRow {
  variantId: string
  code: string
  name: string
  categoryName: string
  /** Занято единиц-дней. */
  bookedDays: number
  /** Доступно единиц-дней в сезоне. */
  capacityDays: number
  /** 0…1. Считается только по дням в сезоне. */
  utilization: number
}

export async function utilizationReport(
  c: PoolClient,
  opts: { tenantId: string, branchId?: string } & Period,
): Promise<UtilizationRow[]> {
  const { rows } = await c.query<Record<string, unknown>>(
    `SELECT v.id AS variant_id, v.code, v.name,
            cat.code AS category_code, cat.name AS category_name,
            COALESCE(SUM(pd.qty_booked), 0)::int AS booked_days,
            COALESCE(SUM(pd.capacity), 0)::int   AS capacity_days
     FROM inventory_variant v
     JOIN category cat ON cat.id = v.category_id
     LEFT JOIN pool_day pd
            ON pd.variant_id = v.id
           AND pd.day BETWEEN $3::date AND $4::date
           -- ⚠️ Только дни в сезоне: иначе сапборды зимой дают 0%.
           AND season_month_active(EXTRACT(MONTH FROM pd.day)::int,
                                   cat.season_from_month, cat.season_to_month)
     WHERE v.tenant_id = $1 AND v.archived_at IS NULL
       AND cat.code <> 'service'
       AND ($2::uuid IS NULL OR v.branch_id = $2)
     GROUP BY v.id, v.code, v.name, cat.code, cat.name, v.sort_order, cat.sort_order
     ORDER BY cat.sort_order, v.sort_order, v.code`,
    [opts.tenantId, opts.branchId ?? null, opts.from, opts.to],
  )

  return rows.map((r) => {
    const booked = (r.booked_days as number) ?? 0
    const capacity = (r.capacity_days as number) ?? 0
    return {
      variantId: r.variant_id as string,
      code: r.code as string,
      name: localized(r.name as I18nField, 'ru', r.code as string),
      categoryName: localized(r.category_name as I18nField, 'ru', r.category_code as string),
      bookedDays: booked,
      capacityDays: capacity,
      utilization: capacity > 0 ? booked / capacity : 0,
    }
  })
}

/* ───────────────────────── выручка ────────────────────────── */

export interface RevenueRow {
  /** День в поясе филиала, YYYY-MM-DD. */
  day: string
  orders: number
  /** numeric строкой: деньги не проходят через JS-число. */
  amount: string
}

export interface RevenueReport {
  byDay: RevenueRow[]
  totalAmount: string
  totalOrders: number
  /** Средний чек строкой. */
  averageCheck: string
}

/**
 * Выручка по дням.
 *
 * ⚠️ Считаются только ЗАВЕРШЁННЫЕ и ВЫДАННЫЕ заказы: отменённые и
 * истёкшие денег не принесли, а включить их значит показать владельцу
 * выручку, которой не было, и построить на ней решение о закупке.
 *
 * ⚠️ День берётся в поясе ФИЛИАЛА, а не в UTC: заказ, выданный
 * в 23:30 по Красноярску, в UTC попадает на предыдущие сутки, и
 * сверка с кассовой сменой не сойдётся.
 */
export async function revenueReport(
  c: PoolClient,
  opts: { tenantId: string, branchId?: string } & Period,
): Promise<RevenueReport> {
  const { rows } = await c.query<{ day: string, orders: number, amount: string }>(
    `SELECT to_char((lower(o.period) AT TIME ZONE b.timezone)::date, 'YYYY-MM-DD') AS day,
            count(*)::int AS orders,
            COALESCE(SUM(o.total_amount), 0)::text AS amount
     FROM rental_order o
     JOIN branch b ON b.id = o.branch_pickup_id
     WHERE o.tenant_id = $1
       AND ($2::uuid IS NULL OR o.branch_pickup_id = $2)
       AND (lower(o.period) AT TIME ZONE b.timezone)::date BETWEEN $3::date AND $4::date
       -- ⚠️ Только то, что действительно принесло деньги.
       AND o.status IN ('issued', 'partially_returned', 'returned', 'overdue')
     GROUP BY 1
     ORDER BY 1`,
    [opts.tenantId, opts.branchId ?? null, opts.from, opts.to],
  )

  const { rows: total } = await c.query<{ amount: string, orders: number, avg: string }>(
    `SELECT COALESCE(SUM(o.total_amount), 0)::text AS amount,
            count(*)::int AS orders,
            COALESCE(ROUND(AVG(o.total_amount), 2), 0)::text AS avg
     FROM rental_order o
     JOIN branch b ON b.id = o.branch_pickup_id
     WHERE o.tenant_id = $1
       AND ($2::uuid IS NULL OR o.branch_pickup_id = $2)
       AND (lower(o.period) AT TIME ZONE b.timezone)::date BETWEEN $3::date AND $4::date
       AND o.status IN ('issued', 'partially_returned', 'returned', 'overdue')`,
    [opts.tenantId, opts.branchId ?? null, opts.from, opts.to],
  )

  return {
    byDay: rows,
    totalAmount: total[0]?.amount ?? '0',
    totalOrders: total[0]?.orders ?? 0,
    averageCheck: total[0]?.avg ?? '0',
  }
}

/* ────────────────────────── неявки ────────────────────────── */

export interface NoShowReport {
  total: number
  /** Доля неявок среди подтверждённых заказов, 0…1. */
  rate: number
  confirmed: number
}

/**
 * Неявки.
 *
 * ⚠️ Отдаётся ДОЛЯ, а не только число: «12 неявок» ничего не значит
 * без знания, из скольких. При 30 заказах это катастрофа, при 3000 —
 * шум. Владелец принимает решение о предоплате именно по доле.
 */
export async function noShowReport(
  c: PoolClient,
  opts: { tenantId: string, branchId?: string } & Period,
): Promise<NoShowReport> {
  const { rows } = await c.query<{ no_show: number, confirmed: number }>(
    `SELECT count(*) FILTER (WHERE o.status = 'no_show')::int AS no_show,
            count(*) FILTER (
              WHERE o.status IN ('confirmed', 'issued', 'partially_returned',
                                 'returned', 'overdue', 'no_show')
            )::int AS confirmed
     FROM rental_order o
     JOIN branch b ON b.id = o.branch_pickup_id
     WHERE o.tenant_id = $1
       AND ($2::uuid IS NULL OR o.branch_pickup_id = $2)
       AND (lower(o.period) AT TIME ZONE b.timezone)::date BETWEEN $3::date AND $4::date`,
    [opts.tenantId, opts.branchId ?? null, opts.from, opts.to],
  )
  const r = rows[0]
  const confirmed = r?.confirmed ?? 0
  return {
    total: r?.no_show ?? 0,
    confirmed,
    rate: confirmed > 0 ? (r?.no_show ?? 0) / confirmed : 0,
  }
}

/* ───────────────────── популярные размеры ─────────────────── */

export interface PopularSizeRow {
  code: string
  name: string
  categoryName: string
  /** Сколько раз брали. */
  taken: number
  /** Сколько раз не хватило — отказы по наличию. */
  refused: number
}

/**
 * ⭐ Популярные размеры — самый ценный отчёт для закупки.
 *
 * ⚠️ Показывает не только «что брали», но и «чего не хватило».
 * По одному «брали» решение принять нельзя: размер может быть
 * популярен именно потому, что его много, а редкий — потому что
 * его вечно нет. Пара «взято / отказано» отвечает на вопрос
 * «чего докупить» напрямую.
 */
export async function popularSizesReport(
  c: PoolClient,
  opts: { tenantId: string, branchId?: string } & Period,
): Promise<PopularSizeRow[]> {
  const { rows } = await c.query<Record<string, unknown>>(
    `WITH taken AS (
       SELECT ol.variant_id, SUM(ol.qty)::int AS n
       FROM order_line ol
       JOIN rental_order o ON o.id = ol.order_id
       JOIN branch b ON b.id = o.branch_pickup_id
       WHERE o.tenant_id = $1
         AND ($2::uuid IS NULL OR o.branch_pickup_id = $2)
         AND (lower(o.period) AT TIME ZONE b.timezone)::date BETWEEN $3::date AND $4::date
         AND o.status IN ('issued', 'partially_returned', 'returned', 'overdue')
       GROUP BY ol.variant_id
     ),
     refused AS (
       SELECT d.variant_id, SUM(d.rejected)::int AS n
       FROM demand_daily d
       WHERE d.tenant_id = $1
         AND ($2::uuid IS NULL OR d.branch_id = $2)
         AND d.day BETWEEN $3::date AND $4::date
         AND d.reason_code = 'no_availability'
       GROUP BY d.variant_id
     )
     SELECT v.code, v.name, cat.code AS category_code, cat.name AS category_name,
            COALESCE(t.n, 0) AS taken, COALESCE(r.n, 0) AS refused
     FROM inventory_variant v
     JOIN category cat ON cat.id = v.category_id
     LEFT JOIN taken t   ON t.variant_id = v.id
     LEFT JOIN refused r ON r.variant_id = v.id
     WHERE v.tenant_id = $1 AND v.archived_at IS NULL
       AND cat.code <> 'service'
       AND (COALESCE(t.n, 0) > 0 OR COALESCE(r.n, 0) > 0)
     ORDER BY COALESCE(t.n, 0) + COALESCE(r.n, 0) DESC
     LIMIT 50`,
    [opts.tenantId, opts.branchId ?? null, opts.from, opts.to],
  )

  return rows.map((r) => ({
    code: r.code as string,
    name: localized(r.name as I18nField, 'ru', r.code as string),
    categoryName: localized(r.category_name as I18nField, 'ru', r.category_code as string),
    taken: (r.taken as number) ?? 0,
    refused: (r.refused as number) ?? 0,
  }))
}

/* ────────────────────────── мёртвый сток ──────────────────── */

export interface DeadStockRow {
  code: string
  name: string
  categoryName: string
  /** Сколько единиц лежит. */
  onHand: number
  /** Сколько раз брали за период. */
  taken: number
  /** Дней с последней выдачи; null — не брали ни разу. */
  daysIdle: number | null
}

/**
 * Мёртвый сток — что лежит и не приносит денег.
 *
 * ⚠️ Считается только по позициям В СЕЗОНЕ на конец периода. Сапборды
 * в январе не мёртвый сток, а межсезонье, и предлагать их списать —
 * прямой убыток для проката, который послушается отчёта.
 *
 * ⚠️ «Ни разу не брали» и «не брали 60 дней» — разные случаи, и они
 * различаются: первое может означать, что позицию завели вчера.
 * Поэтому отдаётся дата последней выдачи, а не только счётчик.
 */
export async function deadStockReport(
  c: PoolClient,
  opts: { tenantId: string, branchId?: string } & Period,
): Promise<DeadStockRow[]> {
  const { rows } = await c.query<Record<string, unknown>>(
    `WITH taken AS (
       SELECT ol.variant_id,
              SUM(ol.qty)::int AS n,
              MAX(lower(o.period)) AS last_at
       FROM order_line ol
       JOIN rental_order o ON o.id = ol.order_id
       WHERE o.tenant_id = $1
         AND o.status IN ('issued', 'partially_returned', 'returned', 'overdue')
       GROUP BY ol.variant_id
     ),
     stock AS (
       SELECT m.variant_id, SUM(m.qty)::int AS on_hand
       FROM movement m
       WHERE m.tenant_id = $1
       GROUP BY m.variant_id
     )
     SELECT v.code, v.name, cat.code AS category_code, cat.name AS category_name,
            COALESCE(s.on_hand, 0) AS on_hand,
            COALESCE(t.n, 0) AS taken,
            -- ⚠️ GREATEST(...,0): последняя выдача может быть в БУДУЩЕМ —
            -- заказ на следующий сезон уже подтверждён, а период ещё
            -- не начался. Без ограничения «дней простоя» уходило
            -- в минус (−74), и отчёт «мёртвый сток» показывал вещь,
            -- забронированную вперёд, то есть ровно обратное своему
            -- смыслу. Ноль здесь честен: вещь не простаивает.
            CASE WHEN t.last_at IS NULL THEN NULL
                 ELSE GREATEST(EXTRACT(DAY FROM (now() - t.last_at))::int, 0)
                 END AS days_idle
     FROM inventory_variant v
     JOIN category cat ON cat.id = v.category_id
     LEFT JOIN taken t ON t.variant_id = v.id
     LEFT JOIN stock s ON s.variant_id = v.id
     WHERE v.tenant_id = $1 AND v.archived_at IS NULL
       AND cat.code <> 'service'
       AND ($2::uuid IS NULL OR v.branch_id = $2)
       -- ⚠️ Только позиции В СЕЗОНЕ: межсезонье это не мёртвый сток.
       AND season_month_active(EXTRACT(MONTH FROM $4::date)::int,
                               cat.season_from_month, cat.season_to_month)
       AND COALESCE(s.on_hand, 0) > 0
       -- Мёртвым считается то, что за период не взяли ни разу.
       AND COALESCE((
         SELECT SUM(ol.qty) FROM order_line ol
         JOIN rental_order o ON o.id = ol.order_id
         WHERE ol.variant_id = v.id
           AND o.status IN ('issued','partially_returned','returned','overdue')
           AND lower(o.period)::date BETWEEN $3::date AND $4::date
       ), 0) = 0
     ORDER BY COALESCE(s.on_hand, 0) DESC
     LIMIT 50`,
    [opts.tenantId, opts.branchId ?? null, opts.from, opts.to],
  )

  return rows.map((r) => ({
    code: r.code as string,
    name: localized(r.name as I18nField, 'ru', r.code as string),
    categoryName: localized(r.category_name as I18nField, 'ru', r.category_code as string),
    onHand: (r.on_hand as number) ?? 0,
    taken: (r.taken as number) ?? 0,
    daysIdle: (r.days_idle as number) ?? null,
  }))
}
