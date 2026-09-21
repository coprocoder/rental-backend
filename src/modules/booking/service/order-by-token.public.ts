/**
 * Просмотр заказа клиентом по ссылке.
 *
 * Клиент не регистрируется — доступ даётся токеном из уведомления
 * (../rental-docs/docs/04-тз/10-бэкенд/17-доступ-и-роли.md). Это данные самого клиента,
 * поэтому просмотр не требует ни кода, ни подтверждения.
 *
 * ⚠️ Неизвестный и истёкший токен дают ОДИН И ТОТ ЖЕ ответ: разные
 * ответы подсказывают перебирающему, что токен угадан верно.
 */
import type { Deps } from '~/kernel/deps'
import { apiError } from '~/kernel/errors'
import { locateByToken } from '~/domain/orders/order-token'
import { localized, type I18nField } from '~/common/utils/i18n-field'

export interface GetOrderByTokenInput {
  params: Record<string, string>
}

export async function getOrderByToken(
  req: GetOrderByTokenInput,
  deps: Deps,
) {
  const token = req.params.token ?? ''

  // Шаг 1: узнать тенанта — он закодирован в самом токене.
  const hit = await deps.db.txAnonymous((c) => locateByToken(c, token, 'view'))
  if (!hit) throw apiError('NOT_FOUND', 'Ссылка недействительна или истекла')

  // Шаг 2: данные читаются уже в тенантном контексте, под RLS.
  return deps.db.tx(hit.tenantId, async (c) => {
    const { rows } = await c.query(
      `SELECT o.public_code, o.status, o.total_amount, o.price_breakdown,
              lower(o.period) AS starts_at, upper(o.period) AS ends_at,
              o.confirm_deadline, o.confirmed_at,
              b.name AS branch_name, b.address, b.timezone,
              cu.name AS customer_name, cu.phone
       FROM rental_order o
       JOIN branch b ON b.id = o.branch_pickup_id
       LEFT JOIN customer cu ON cu.id = o.customer_id
       WHERE o.id = $1`,
      [hit.orderId],
    )
    const order = rows[0]
    if (!order) throw apiError('NOT_FOUND', 'Заказ не найден')

    const lines = await c.query(
      `SELECT l.qty, l.amount, l.status,
              v.name AS variant_name, c.name AS category_name
       FROM order_line l
       LEFT JOIN inventory_variant v ON v.id = l.variant_id
       LEFT JOIN category c ON c.id = v.category_id
       WHERE l.order_id = $1
       ORDER BY c.sort_order, v.sort_order`,
      [hit.orderId],
    )

    // ⚠️ Названия разворачиваются по локали здесь, а не в компоненте
    // (8.7): в браузер должна прийти строка. Иначе клиент увидит
    // «[object Object]» вместо «Ботинки 42» — так уже было на стойке.
    return {
      order,
      lines: lines.rows.map((l) => ({
        ...l,
        variant_name: localized(l.variant_name as I18nField, 'ru', ''),
        category_name: localized(l.category_name as I18nField, 'ru', ''),
      })),
    }
  })
}
