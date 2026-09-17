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
import * as v from 'valibot'
import { documentRoute } from '~/transport/openapi/registry'

/**
 * Ответ на создание заказа.
 *
 * ⚠️ Три РАЗНЫХ токена: посмотреть, подтвердить, отменить. Ссылка
 * «посмотреть» не должна давать возможность отменить бронь — сервер
 * их различает, и view-токен на `/confirm` отвечает 404.
 *
 * ⚠️ `confirmDeadline` бывает null: у брони «меньше суток до начала»
 * автоотмены нет, и обещать срок, которого нет в записи, нельзя.
 */
const CreateOrderResponse = v.object({
  code: v.string(),
  status: v.string(),
  total: v.string(),
  days: v.number(),
  /** Крупный заказ проверяет оператор: снаряжение ещё не забронировано. */
  needsOperator: v.boolean(),
  confirmDeadline: v.nullable(v.string()),
  links: v.object({
    view: v.string(),
    confirm: v.string(),
    cancel: v.string(),
  }),
})

/**
 * Заказ, открытый клиентом по ссылке из уведомления.
 *
 * ⚠️ Поля в `snake_case`, в отличие от остальных ответов API: слой
 * отдаёт строки БД как есть. Схема описывает РЕАЛЬНОСТЬ, а не желаемое;
 * переименование — отдельная правка с версией API, здесь она сломала бы
 * работающий экран клиента.
 */
const OrderByTokenResponse = v.object({
  order: v.object({
    public_code: v.string(),
    status: v.string(),
    total_amount: v.string(),
    price_breakdown: v.record(v.string(), v.unknown()),
    starts_at: v.string(),
    ends_at: v.string(),
    confirm_deadline: v.nullable(v.string()),
    confirmed_at: v.nullable(v.string()),
    branch_name: v.string(),
    address: v.nullable(v.string()),
    timezone: v.string(),
    customer_name: v.nullable(v.string()),
    phone: v.string(),
  }),
  lines: v.array(v.object({
    qty: v.number(),
    amount: v.string(),
    status: v.string(),
    variant_name: v.string(),
    category_name: v.string(),
  })),
})

documentRoute({
  method: 'post',
  path: '/v1/public/orders',
  summary: 'Создание заказа с витрины или виджета',
  scope: 'public',
  response: CreateOrderResponse,
})

documentRoute({
  method: 'get',
  path: '/v1/public/orders/:token',
  summary: 'Заказ по ссылке из уведомления: состав, срок, статус',
  scope: 'public',
  response: OrderByTokenResponse,
})

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
