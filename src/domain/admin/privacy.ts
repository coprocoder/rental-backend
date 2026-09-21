/**
 * Персональные данные: обезличивание, экспорт, удаление.
 *
 * Требования 152-ФЗ (../rental-docs/docs/04-тз/00-общее/04-правовое.md): данные хранятся не
 * дольше, чем нужно для цели обработки, а субъект вправе получить их
 * копию и потребовать удаления.
 *
 * ⚠️ Платформа — ОБРАБОТЧИК, а не оператор персональных данных: оператор
 * это прокат. Поэтому запрос субъекта приходит через тенанта, а не
 * напрямую к нам, и функции здесь вызываются от имени тенанта.
 *
 * ⚠️ Обезличивание, а не удаление заказа. Удалить строку заказа нельзя:
 * на неё ссылаются движения склада, записи DIN («кто проверил
 * крепления») и выручка. Стирается ТОЛЬКО то, что делает человека
 * узнаваемым, а сам факт аренды остаётся — иначе рассыпается и учёт,
 * и след ответственности за настройку креплений.
 */
import type { PoolClient } from 'pg'
import { audit } from '../core/order-lifecycle'

/**
 * Обезличивает клиентов, у которых истёк срок хранения.
 *
 * ⚠️ Срок берётся из rental_order.retention_until: он проставляется при
 * создании заказа, потому что зависит от даты аренды, а не от даты
 * обработки. Клиент обезличивается, когда истёк срок ВСЕХ его заказов —
 * иначе свежая аренда потеряла бы контакт вместе со старой.
 */
export async function anonymizeExpired(
  c: PoolClient,
  opts: { limit?: number } = {},
): Promise<{ anonymized: number }> {
  const { rows } = await c.query<{ id: string }>(
    `WITH ready AS (
       SELECT cu.id
       FROM customer cu
       WHERE cu.phone NOT LIKE 'deleted:%'
         AND NOT EXISTS (
           SELECT 1 FROM rental_order o
           WHERE o.customer_id = cu.id
             AND (o.retention_until IS NULL OR o.retention_until > now())
         )
         -- У клиента должен быть хотя бы один заказ: свежесозданные
         -- записи без заказов трогать нельзя, они в процессе оформления.
         AND EXISTS (SELECT 1 FROM rental_order o WHERE o.customer_id = cu.id)
       LIMIT $1
     )
     UPDATE customer cu
     SET
       -- ⚠️ Телефон не обнуляется, а заменяется меткой: колонка NOT NULL
       -- и уникальна в пределах тенанта, а несколько NULL нарушили бы
       -- уникальность иначе. Плюс по метке видно, что это обезличенная
       -- запись, а не ошибка ввода.
       phone = 'deleted:' || cu.id::text,
       name = NULL,
       email = NULL,
       messenger = NULL,
       messenger_chat_id = NULL,
       -- Параметры тела стираются: рост, вес и размер обуви вместе с
       -- историей аренд — это профиль конкретного человека.
       body_params = NULL
     FROM ready
     WHERE cu.id = ready.id
     RETURNING cu.id`,
    [opts.limit ?? 200],
  )

  return { anonymized: rows.length }
}

export interface SubjectData {
  customer: Record<string, unknown> | null
  orders: Record<string, unknown>[]
  consents: Record<string, unknown>[]
  agreements: Record<string, unknown>[]
  waitlist: Record<string, unknown>[]
}

/**
 * Экспорт данных субъекта по телефону.
 *
 * ⚠️ Отдаётся то, что относится к самому человеку, и НЕ отдаётся
 * внутренняя аналитика проката: demand_daily обезличен и агрегирован,
 * а audit_log содержит действия сотрудников — это данные тенанта,
 * а не субъекта.
 */
export async function exportSubjectData(
  c: PoolClient,
  opts: { tenantId: string, phone: string },
): Promise<SubjectData> {
  const { rows: customer } = await c.query(
    `SELECT id, phone, name, email, messenger, body_params,
            no_show_count, created_at
     FROM customer WHERE tenant_id = $1 AND phone = $2`,
    [opts.tenantId, opts.phone],
  )
  const cust = customer[0]
  if (!cust) return { customer: null, orders: [], consents: [], agreements: [], waitlist: [] }

  const customerId = cust.id as string

  const { rows: orders } = await c.query(
    `SELECT o.public_code, o.status, o.total_amount, o.price_breakdown,
            lower(o.period) AS starts_at, upper(o.period) AS ends_at,
            o.created_at, o.retention_until, b.name AS branch
     FROM rental_order o
     JOIN branch b ON b.id = o.branch_pickup_id
     WHERE o.customer_id = $1
     ORDER BY o.created_at`,
    [customerId],
  )

  const { rows: consents } = await c.query(
    `SELECT kind, text_version, granted_at, revoked_at, ip
     FROM consent WHERE customer_id = $1 ORDER BY granted_at`,
    [customerId],
  )

  // ⚠️ Договоры входят в экспорт: человек вправе получить копию того,
  // что подписал, и это же его доказательство в споре.
  const { rows: agreements } = await c.query(
    `SELECT a.offer_version, a.offer_hash, a.signed_at, a.sign_channel, o.public_code
     FROM agreement a
     JOIN rental_order o ON o.id = a.order_id
     WHERE o.customer_id = $1
     ORDER BY a.signed_at`,
    [customerId],
  )

  const { rows: waitlist } = await c.query(
    `SELECT status, created_at, expires_at,
            lower(period) AS wants_from, upper(period) AS wants_to
     FROM waitlist WHERE customer_id = $1 ORDER BY created_at`,
    [customerId],
  )

  return { customer: cust, orders, consents, agreements, waitlist }
}

/**
 * Удаление данных субъекта по требованию.
 *
 * ⚠️ Это обезличивание, а не DELETE, и по той же причине: строку заказа
 * удалить нельзя, на неё ссылаются движения склада и запись «кто
 * выставил DIN». Требование субъекта исполняется в части персональных
 * данных, а хозяйственные записи остаются — они не персональные.
 *
 * ⚠️ Факт удаления пишется в audit_log: без него невозможно доказать,
 * что требование исполнено, а это обязанность оператора.
 */
export async function deleteSubjectData(
  c: PoolClient,
  opts: { tenantId: string, phone: string, staffId: string, reason?: string },
): Promise<{ deleted: boolean, ordersAffected: number }> {
  const { rows } = await c.query<{ id: string }>(
    `SELECT id FROM customer WHERE tenant_id = $1 AND phone = $2`,
    [opts.tenantId, opts.phone],
  )
  const cust = rows[0]
  if (!cust) return { deleted: false, ordersAffected: 0 }

  const { rows: affected } = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM rental_order WHERE customer_id = $1`,
    [cust.id],
  )

  await c.query(
    `UPDATE customer
     SET phone = 'deleted:' || id::text,
         name = NULL, email = NULL,
         messenger = NULL, messenger_chat_id = NULL,
         body_params = NULL
     WHERE id = $1`,
    [cust.id],
  )

  // Согласия помечаются отозванными: они больше не действуют.
  await c.query(
    `UPDATE consent SET revoked_at = now()
     WHERE customer_id = $1 AND revoked_at IS NULL`,
    [cust.id],
  )

  await audit(c, {
    tenantId: opts.tenantId,
    staffId: opts.staffId,
    action: 'privacy.subject_deleted',
    targetType: 'customer',
    targetId: cust.id,
    reason: opts.reason ?? 'требование субъекта персональных данных',
    after: { ordersAffected: affected[0]?.n ?? 0 },
  })

  return { deleted: true, ordersAffected: affected[0]?.n ?? 0 }
}

/**
 * Полный экспорт данных тенанта (14.6).
 *
 * ⚠️ Нужен не только по закону, но и как аргумент при продаже: прокат
 * должен видеть, что его данные не заперты в системе. «Не сможете
 * уйти» — плохой способ удерживать подписку, и он же главное
 * возражение при покупке.
 */
export async function exportTenantData(
  c: PoolClient,
  tenantId: string,
): Promise<Record<string, Record<string, unknown>[]>> {
  const out: Record<string, Record<string, unknown>[]> = {}

  // Таблицы, которые действительно принадлежат тенанту.
  // ⚠️ Список явный, а не «все таблицы»: иначе в выгрузку попадут
  // системные journals и чужие данные при ошибке в RLS.
  const tables = [
    'branch', 'category', 'inventory_variant', 'item', 'price_rule',
    'fit_rule', 'set_template', 'schedule', 'staff', 'customer',
    'rental_order', 'order_line', 'movement', 'shift', 'consent',
    'agreement', 'waitlist', 'demand_daily', 'audit_log', 'event',
  ]

  for (const table of tables) {
    // ⚠️ Имя таблицы нельзя передать параметром, поэтому оно проверяется
    // по белому списку выше И по формату здесь. Двойная проверка не
    // паранойя: список может пополниться копированием строки, и тогда
    // единственной защитой останется формат.
    if (!/^[a-z_]+$/.test(table)) continue

    const { rows } = await c.query(
      `SELECT * FROM ${table} WHERE tenant_id = $1`,
      [tenantId],
    )
    out[table] = rows
  }

  return out
}
