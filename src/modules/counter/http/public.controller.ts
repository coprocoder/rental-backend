/**
 * Маршрут карточки заказа на стойке.
 *
 * ⚠️ Доступ по `id` и по сессии сотрудника, а не по токену клиента:
 * токен — вид доступа для НЕаутентифицированного клиента к одному
 * своему заказу.
 */
import type { App } from '~/transport/types'
import type { Deps } from '~/kernel/deps'
import { requireSession, SESSION_COOKIE } from '~/kernel/session'
import { getCounterOrder } from '../service/order-detail.public'

export function registerCounterPublic(app: App, deps: Deps): void {
  app.get<{ Params: { id: string } }>('/v1/counter/orders/:id', async (httpReq) => {
    const s = await requireSession(httpReq.cookies[SESSION_COOKIE])
    return getCounterOrder(s, { params: httpReq.params as Record<string, string> }, deps)
  })
}
