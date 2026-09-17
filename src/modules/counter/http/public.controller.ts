/**
 * Маршрут карточки заказа на стойке.
 *
 * ⚠️ Доступ по `id` и по сессии сотрудника, а не по токену клиента:
 * токен — вид доступа для НЕаутентифицированного клиента к одному
 * своему заказу.
 */
import type { App } from '~/transport/types'
import type { Deps } from '~/kernel/deps'
import * as v from 'valibot'
import { documentRoute } from '~/transport/openapi/registry'
import { requireSession, SESSION_COOKIE } from '~/kernel/session'
import { getCounterOrder } from '../service/order-detail.public'

const CounterOrderResponse = v.object({
  id: v.pipe(v.string(), v.uuid()),
  publicCode: v.string(),
  status: v.string(),
  branchName: v.string(),
  branchAddress: v.nullable(v.string()),
  tenantName: v.string(),
  branchId: v.pipe(v.string(), v.uuid()),
  timezone: v.string(),
  startsAt: v.string(),
  endsAt: v.string(),
  total: v.nullable(v.string()),
  priceBreakdown: v.nullable(v.record(v.string(), v.unknown())),
  confirmDeadline: v.nullable(v.string()),
  createdAt: v.string(),
  customer: v.nullable(v.record(v.string(), v.unknown())),
  lines: v.array(v.record(v.string(), v.unknown())),
  agreement: v.optional(v.nullable(v.record(v.string(), v.unknown()))),
})

documentRoute({ method: 'get', path: '/v1/counter/orders/:id', scope: 'staff',
  response: CounterOrderResponse,
  summary: 'Заказ на экране стойки: состав и всё нужное для выдачи' })

export function registerCounterPublic(app: App, deps: Deps): void {
  app.get<{ Params: { id: string } }>('/v1/counter/orders/:id', async (httpReq) => {
    const s = await requireSession(httpReq.cookies[SESSION_COOKIE])
    return getCounterOrder(s, { params: httpReq.params as Record<string, string> }, deps)
  })
}
