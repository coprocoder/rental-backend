/**
 * Маршруты админки модуля `booking`.
 *
 * ⚠️ Право и тариф — ДВЕ РАЗНЫЕ проверки: «этому сотруднику можно?» и
 * «этот прокат оплатил?». Проверять по отдельности в каждом обработчике
 * — значит однажды забыть вторую и раздать платную функцию бесплатно.
 */
import type { App } from '~/transport/types'
import type { Deps } from '~/kernel/deps'
import { SESSION_COOKIE, requirePermission, requireSession } from '~/kernel/session'
import { getWaitlist } from '../service/admin-waitlist.service'
import { getOrders } from '../service/admin-orders.service'
import { getOrderDetail, getOrderTimeline } from '../service/order-detail.service'

export function registerBookingAdminRoutes(app: App, deps: Deps): void {
  app.get('/v1/admin/waitlist', async (req) => {
    const s = await requireSession(req.cookies[SESSION_COOKIE])
    return getWaitlist(s, req.query as Record<string, unknown>, deps)
  })
  /**
   * ⚠️ Доступ по `id`, а не по токену: токен — вид доступа для
   * НЕаутентифицированного клиента к одному своему заказу. Токен в
   * маршруте персонала означал бы доступ к заказу по знанию ссылки.
   */
  app.get<{ Params: { id: string } }>('/v1/admin/orders/:id', async (req) => {
    const s = await requireSession(req.cookies[SESSION_COOKIE])
    return getOrderDetail(s, req.params.id, deps)
  })

  app.get<{ Params: { id: string } }>('/v1/admin/orders/:id/timeline', async (req) => {
    const s = await requireSession(req.cookies[SESSION_COOKIE])
    return getOrderTimeline(s, req.params.id, deps)
  })

  app.get('/v1/admin/orders', async (req) => {
    const s = await requirePermission(req.cookies[SESSION_COOKIE], 'order.confirm')
    return getOrders(s, req.query as Record<string, unknown>, deps)
  })
}
