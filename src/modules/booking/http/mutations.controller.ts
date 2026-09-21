/**
 * Мутации модуля `booking`.
 *
 * ⚠️ Право и тариф — ДВЕ РАЗНЫЕ проверки, и для мутаций цена ошибки
 * выше, чем для чтения: забытая проверка тарифа раздаёт платную
 * функцию, забытое право — доступ к чужим действиям.
 */
import type { App } from '~/transport/types'
import type { Deps } from '~/kernel/deps'
import { SESSION_COOKIE, requireSession } from '~/kernel/session'
import * as v from 'valibot'
import { documentRoute } from '~/transport/openapi/registry'
import { postOrderAction, OrderActionBody } from '../service/action.mutation'
import { OrderDetailSchema } from '~/transport/schemas/order-detail'

documentRoute({ method: 'post', path: '/v1/admin/orders/:id/action', scope: 'staff',
  body: OrderActionBody,
  /**
   * ⚠️ Возвращается ВСЯ карточка заказа, а не подтверждение: экран
   * обновляет её на месте, без второго запроса. Та же схема, что у
   * GET — объект отдаёт одна доменная функция `orderDetail`.
   */
  response: OrderDetailSchema,
  summary: 'Ручные действия над заказом: подтвердить, отменить, отметить неявку' })

export function registerBookingMutations(app: App, deps: Deps): void {
  app.post<{ Params: { id: string } }>('/v1/admin/orders/:id/action', async (httpReq) => {
    const s = await requireSession(httpReq.cookies[SESSION_COOKIE])
    return postOrderAction(s, { body: httpReq.body, params: httpReq.params as Record<string, string> }, deps)
  })
}
