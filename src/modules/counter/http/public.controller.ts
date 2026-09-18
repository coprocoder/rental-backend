/**
 * Маршрут карточки заказа на стойке.
 *
 * ⚠️ Доступ по `id` и по сессии сотрудника, а не по токену клиента:
 * токен — вид доступа для НЕаутентифицированного клиента к одному
 * своему заказу.
 */
import type { App } from '~/transport/types'
import type { Deps } from '~/kernel/deps'
import { documentRoute } from '~/transport/openapi/registry'
import { OrderDetailSchema } from '~/transport/schemas/order-detail'
import { requireSession, SESSION_COOKIE } from '~/kernel/session'
import { getCounterOrder } from '../service/order-detail.public'

/**
 * ⚠️ Та же схема, что у админки: объект отдаёт одна доменная функция
 * `orderDetail`. Здесь была своя, более грубая версия — строки заказа
 * как `record(string, unknown)`, — и экран стойки получал `unknown`
 * вместо типа на 34 обращения к полям.
 */
const CounterOrderResponse = OrderDetailSchema

documentRoute({ method: 'get', path: '/v1/counter/orders/:id', scope: 'staff',
  response: CounterOrderResponse,
  summary: 'Заказ на экране стойки: состав и всё нужное для выдачи' })

export function registerCounterPublic(app: App, deps: Deps): void {
  app.get<{ Params: { id: string } }>('/v1/counter/orders/:id', async (httpReq) => {
    const s = await requireSession(httpReq.cookies[SESSION_COOKIE])
    return getCounterOrder(s, { params: httpReq.params as Record<string, string> }, deps)
  })
}
