/**
 * Обслуживание инвентаря: список работ техника и возврат в оборот.
 *
 * Спека: ../rental-docs/docs/04-тз/10-бэкенд/17-доступ-и-роли.md
 *
 * ⚠️ Техник — ОТДЕЛЬНАЯ роль по правовым причинам, а не для удобства:
 * запись DIN это след ответственности, и на вопрос «кто выставил
 * значение на этих креплениях» должен быть ответ с именем
 * (../rental-docs/docs/04-тз/00-общее/04-правовое.md). В Австрии
 * регулировкой вправе заниматься только сертифицированный Sportmonteur.
 *
 * ⚠️ При поимённом учёте в списке КОНКРЕТНЫЕ вещи с номерами, а при
 * количественном — строки «столько-то штук». Это одна и та же таблица
 * движений, разница только в том, заполнен ли `item_id`: техник должен
 * видеть, какую вещь взять со стеллажа, а не «один борд из шести».
 *
 * ⚠️ Список строится ИЗ ДВИЖЕНИЙ, а не из отдельной таблицы заявок.
 * Вещь уходит в обслуживание движением `to_service` (это делает стойка
 * при возврате повреждённого) и возвращается движением `from_service`.
 * Вторая таблица со своим статусом разошлась бы с движениями на первом
 * же расхождении, а сходятся они только тогда, когда источник один.
 */
import type { PoolClient } from 'pg'
import { localized, type I18nField } from '~/common/utils/i18n-field'

export interface ServiceTask {
  /** Заполнен при поимённом учёте: конкретная вещь. */
  itemId: string | null
  labelCode: string | null
  variantId: string
  variantName: string
  categoryName: string
  branchId: string
  branchName: string
  /** Сколько единиц этой позиции сейчас в обслуживании. */
  qty: number
  /** Вид работы: сушка, заточка, парафин, ремонт, осмотр. */
  serviceKind: string | null
  /** Когда вещь ушла в обслуживание. */
  since: string
  /** Сколько дней лежит — по нему список и сортируется. */
  days: number
}

/**
 * Что сейчас в обслуживании.
 *
 * ⚠️ В отличие от `stuckInService` (ревизия, «что забыли») здесь порога
 * по дням НЕТ: технику нужен весь список работ, включая сегодняшние.
 * Забытое он и так увидит первым — сортировка по дате поступления.
 */
export async function serviceTasks(
  c: PoolClient,
  opts: { tenantId: string, branchIds?: string[] },
): Promise<ServiceTask[]> {
  const scoped = (opts.branchIds?.length ?? 0) > 0

  const { rows } = await c.query<{
    variant_id: string
    item_id: string | null
    label_code: string | null
    variant_name: I18nField
    variant_code: string
    category_name: I18nField
    category_code: string
    branch_id: string
    branch_name: string
    qty: string
    service_kind: string | null
    since: Date
    days: string
  }>(
    `WITH service AS (
       SELECT variant_id, branch_id,
              -- ⚠️ Группировка ВКЛЮЧАЕТ item_id: при поимённом учёте
              -- каждая вещь — своя строка списка. Без этого номера
              -- схлопнулись бы в «6 шт», и техник снова не знал бы,
              -- какую именно вещь чинить.
              item_id,
              -- ⚠️ to_service записан отрицательным (вещь ушла
              -- из оборота), from_service положительным. Значит
              -- «сейчас в обслуживании» — это МИНУС их сумма.
              -SUM(qty) AS qty,
              MAX(service_kind) FILTER (WHERE kind = 'to_service') AS service_kind,
              MIN(occurred_at) FILTER (WHERE kind = 'to_service') AS since
       FROM movement
       WHERE tenant_id = $1
         AND (NOT $2 OR branch_id = ANY($3::uuid[]))
         AND kind IN ('to_service', 'from_service')
       GROUP BY variant_id, branch_id, item_id
     )
     SELECT s.variant_id, s.branch_id, s.item_id,
            it.label_code,
            v.name AS variant_name, v.code AS variant_code,
            cat.name AS category_name, cat.code AS category_code,
            b.name AS branch_name,
            s.qty::text, s.service_kind, s.since,
            EXTRACT(DAY FROM now() - s.since)::text AS days
     FROM service s
     JOIN inventory_variant v ON v.id = s.variant_id
     JOIN category cat ON cat.id = v.category_id
     JOIN branch b ON b.id = s.branch_id
     LEFT JOIN item it ON it.id = s.item_id
     -- Ноль и минус означают, что всё уже вернулось в оборот.
     WHERE s.qty > 0
     ORDER BY s.since`,
    [opts.tenantId, scoped, opts.branchIds ?? []],
  )

  return rows.map((r) => ({
    itemId: r.item_id,
    labelCode: r.label_code,
    variantId: r.variant_id,
    variantName: localized(r.variant_name, 'ru', r.variant_code),
    categoryName: localized(r.category_name, 'ru', r.category_code),
    branchId: r.branch_id,
    branchName: r.branch_name,
    qty: Number(r.qty),
    serviceKind: r.service_kind,
    since: r.since.toISOString(),
    days: Number(r.days),
  }))
}

/**
 * Вернуть вещь из обслуживания в оборот.
 *
 * ⚠️ Количество проверяется по ТЕКУЩЕМУ остатку в обслуживании,
 * а не принимается на веру: вернуть больше, чем уходило, значит
 * создать единицы из воздуха — склад после этого не сойдётся,
 * а причину будут искать в инвентаризации.
 */
export async function finishService(
  c: PoolClient,
  opts: {
    tenantId: string
    branchId: string
    variantId: string
    qty: number
    /** Конкретная вещь при поимённом учёте. */
    itemId?: string | null
    staffId: string
    /** Что сделали: попадёт в историю вещи. */
    note?: string
  },
): Promise<{ returned: number }> {
  // ⚠️ Остаток считается по ТОЙ ЖЕ единице, если она указана: иначе
  // «вернуть одну» списало бы её с общего счётчика позиции, и вещь
  // с номером осталась бы в обслуживании навсегда.
  const { rows } = await c.query<{ qty: string }>(
    // ⚠️ Скобки обязательны: без них «::text» применяется к SUM
    // раньше унарного минуса, и Postgres пытается вычесть текст.
    `SELECT (-COALESCE(SUM(qty), 0))::text AS qty
       FROM movement
      WHERE tenant_id = $1 AND variant_id = $2 AND branch_id = $3
        AND kind IN ('to_service', 'from_service')
        AND ($4::uuid IS NULL OR item_id = $4)
        AND ($4::uuid IS NOT NULL OR item_id IS NULL)`,
    [opts.tenantId, opts.variantId, opts.branchId, opts.itemId ?? null],
  )
  const inService = Number(rows[0]?.qty ?? 0)
  const qty = Math.min(Math.max(opts.qty, 0), inService)
  if (qty <= 0) return { returned: 0 }

  await c.query(
    `INSERT INTO movement
       (tenant_id, branch_id, variant_id, item_id, kind, qty, staff_id, reason)
     VALUES ($1, $2, $3, $4, 'from_service', $5, $6, $7)`,
    [opts.tenantId, opts.branchId, opts.variantId, opts.itemId ?? null,
     qty, opts.staffId,
     opts.note?.trim() || 'обслуживание завершено'],
  )

  return { returned: qty }
}

export interface ItemHistoryRow {
  at: string
  kind: string
  serviceKind: string | null
  qty: number
  reason: string | null
  staffName: string | null
  orderCode: string | null
}

/**
 * История одной вещи: что с ней происходило.
 *
 * ⚠️ Это и есть то, ради чего вводится поимённый учёт. Спека прямо
 * называет потерю при количественном режиме: «теряется история „эта
 * пара уже трижды ломалась"». Без экрана история осталась бы в
 * журнале, куда никто не смотрит.
 */
export async function itemHistory(
  c: PoolClient,
  opts: { tenantId: string, itemId: string },
): Promise<ItemHistoryRow[]> {
  const { rows } = await c.query<{
    at: Date, kind: string, service_kind: string | null,
    qty: number, reason: string | null,
    staff_name: string | null, order_code: string | null
  }>(
    `SELECT m.occurred_at AS at, m.kind, m.service_kind, m.qty, m.reason,
            st.name AS staff_name, o.public_code AS order_code
       FROM movement m
       LEFT JOIN staff st ON st.id = m.staff_id
       LEFT JOIN rental_order o ON o.id = m.order_id
      WHERE m.tenant_id = $1 AND m.item_id = $2
      -- ⚠️ Вторичный ключ обязателен: отправка в ремонт и возврат
      -- из него происходят в ОДНОЙ транзакции и получают одинаковый
      -- occurred_at. Без него порядок между ними не определён, и
      -- история показывала «вернули из ремонта» ПЕРЕД «отправили
      -- в ремонт» — примерно в одном прогоне из трёх. На стенде такие
      -- совпадения есть: по три движения с одной меткой.
      --
      -- ⚠️ Сортируем по СМЫСЛУ события, а не по id: он случайный
      -- (gen_random_uuid), он дал бы стабильный, но произвольный
      -- порядок. Возврат из сервиса всегда позже отправки в него.
      ORDER BY m.occurred_at DESC,
               CASE m.kind
                 WHEN 'from_service' THEN 0
                 WHEN 'to_service' THEN 1
                 ELSE 2
               END`,
    [opts.tenantId, opts.itemId],
  )

  return rows.map((r) => ({
    at: r.at.toISOString(),
    kind: r.kind,
    serviceKind: r.service_kind,
    qty: r.qty,
    reason: r.reason,
    staffName: r.staff_name,
    orderCode: r.order_code,
  }))
}
