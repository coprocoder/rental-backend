/**
 * Публичные маршруты модуля `booking`.
 *
 * ⚠️ Клиент здесь АНОНИМЕН: сессии нет, тенант определяется слагом
 * витрины или токеном заказа. Токен — не идентификатор: по нему
 * действует неаутентифицированный клиент и видит один свой заказ.
 */
import type { App } from '~/transport/types'
import type { Deps } from '~/kernel/deps'
import { postOrders } from '../service/create-order.public'
import { postConfirm } from '../service/confirm-order.public'
import { postCancel } from '../service/cancel-order.public'
import { postExtend } from '../service/extend-order.public'
import { postSign } from '../service/sign-order.public'
import { getOrderByToken } from '../service/order-by-token.public'
import { postWaitlist } from '../service/waitlist-join.public'
import { postWaitlistToken } from '../service/waitlist-offer.public'

export function registerBookingPublic(app: App, deps: Deps): void {
  app.post('/v1/public/orders', async (httpReq) => {
    return postOrders({ body: httpReq.body, headers: httpReq.headers as Record<string, string | undefined>, ip: httpReq.ip }, deps)
  })
  app.post<{ Params: { token: string } }>('/v1/public/orders/:token/confirm', async (httpReq) => {
    return postConfirm({ params: httpReq.params as Record<string, string>, headers: httpReq.headers as Record<string, string | undefined> }, deps)
  })
  app.post<{ Params: { token: string } }>('/v1/public/orders/:token/cancel', async (httpReq) => {
    return postCancel({ body: httpReq.body, params: httpReq.params as Record<string, string>, headers: httpReq.headers as Record<string, string | undefined> }, deps)
  })
  app.post<{ Params: { token: string } }>('/v1/public/orders/:token/extend', async (httpReq) => {
    return postExtend({ body: httpReq.body, params: httpReq.params as Record<string, string> }, deps)
  })
  app.post<{ Params: { token: string } }>('/v1/public/orders/:token/sign', async (httpReq) => {
    return postSign({ body: httpReq.body, params: httpReq.params as Record<string, string>, ip: httpReq.ip }, deps)
  })
  app.get<{ Params: { token: string } }>('/v1/public/orders/:token', async (httpReq) => {
    return getOrderByToken({ params: httpReq.params as Record<string, string> }, deps)
  })
  app.post('/v1/public/waitlist', async (httpReq) =>
    postWaitlist({
      body: httpReq.body,
      ip: httpReq.ip,
      userAgent: httpReq.headers['user-agent'],
    }, deps))

  app.post<{ Params: { token: string } }>('/v1/public/waitlist/:token', async (httpReq) => {
    return postWaitlistToken({ params: httpReq.params as Record<string, string> }, deps)
  })
}
