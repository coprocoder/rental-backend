/**
 * Маршруты админки модуля `booking`.
 *
 * ⚠️ Право и тариф — ДВЕ РАЗНЫЕ проверки: «этому сотруднику можно?» и
 * «этот прокат оплатил?». Проверять по отдельности в каждом обработчике
 * — значит однажды забыть вторую и раздать платную функцию бесплатно.
 */
import type { App } from '~/transport/types'
import type { Deps } from '~/kernel/deps'
import * as v from 'valibot'
import { documentRoute } from '~/transport/openapi/registry'
import { SESSION_COOKIE, requirePermission, requireSession } from '~/kernel/session'
import { getWaitlist } from '../service/admin-waitlist.service'
import { getOrders } from '../service/admin-orders.service'
import { getOrderDetail, getOrderTimeline } from '../service/order-detail.service'

/**
 * ⚠️ Форма записи НЕ раскрыта: на стенде лист ожидания пуст, и выдумать
 * поля вместо того, чтобы подтвердить их ответом, значило бы написать
 * документацию, которая лжёт. Уточнить, когда появится непустой образец.
 */
const WaitlistResponse = v.object({
  entries: v.array(v.record(v.string(), v.unknown())),
})

documentRoute({ method: 'get', path: '/v1/admin/waitlist', scope: 'staff', response: WaitlistResponse,
  summary: 'Лист ожидания: кто ждёт освободившееся снаряжение' })

const OrdersListResponse = v.object({
  items: v.array(v.object({
    id: v.pipe(v.string(), v.uuid()),
    publicCode: v.string(),
    status: v.string(),
    customerName: v.nullable(v.string()),
    phone: v.nullable(v.string()),
    startsAt: v.string(),
    endsAt: v.string(),
    total: v.nullable(v.string()),
    branchName: v.string(),
  })),
  /**
   * ⚠️ Курсор, а не номер страницы: заказы добавляются постоянно,
   * и offset давал бы дубли и пропуски. `null` — страниц больше нет.
   */
  nextCursor: v.nullable(v.string()),
})

const OrderCardResponse = v.object({
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
  /**
   * ⚠️ Снимок цены с разбором, а не ссылка на правило: иначе правка
   * прайса переписала бы прошлые заказы.
   */
  priceBreakdown: v.nullable(v.record(v.string(), v.unknown())),
  confirmDeadline: v.nullable(v.string()),
  createdAt: v.string(),
  customer: v.nullable(v.object({
    id: v.pipe(v.string(), v.uuid()),
    name: v.nullable(v.string()),
    phone: v.string(),
    email: v.nullable(v.string()),
    /** Сколько раз не пришёл: видно на стойке рядом с заказом. */
    noShowCount: v.number(),
    bodyParams: v.nullable(v.record(v.string(), v.unknown())),
  })),
  lines: v.array(v.object({
    id: v.pipe(v.string(), v.uuid()),
    kind: v.string(),
    variantId: v.pipe(v.string(), v.uuid()),
    variantCode: v.string(),
    variantName: v.string(),
    categoryName: v.string(),
    qty: v.number(),
    amount: v.string(),
    lineStatus: v.string(),
    /** Заполнено при поимённом учёте: какая именно вещь выдана. */
    itemId: v.nullable(v.pipe(v.string(), v.uuid())),
    labelCode: v.nullable(v.string()),
    /**
     * ⚠️ Рекомендация и ФАКТ — разные поля, и это железное правило 7:
     * систему считает рекомендацию, а человек подтверждает значение.
     * Кто проверил и когда — тоже на строке.
     */
    dinRecommended: v.nullable(v.number()),
    dinActual: v.nullable(v.number()),
    verifiedBy: v.nullable(v.string()),
    verifiedAt: v.nullable(v.string()),
    /** BSL: читается с ботинка при выдаче, не хранится за вещью. */
    bootSoleLengthMm: v.nullable(v.number()),
    returnedAt: v.nullable(v.string()),
    conditionNote: v.nullable(v.string()),
  })),
  agreement: v.optional(v.nullable(v.record(v.string(), v.unknown()))),
})

const TimelineResponse = v.object({
  /** История заказа: что, когда и кто сделал. */
  timeline: v.array(v.record(v.string(), v.unknown())),
})

documentRoute({ method: 'get', path: '/v1/admin/orders', scope: 'staff', response: OrdersListResponse,
  summary: 'Список заказов с поиском, фильтрами и курсорной пагинацией' })
documentRoute({ method: 'get', path: '/v1/admin/orders/:id', scope: 'staff', response: OrderCardResponse,
  summary: 'Карточка заказа: состав, цена, клиент, договор' })
documentRoute({ method: 'get', path: '/v1/admin/orders/:id/timeline', scope: 'staff',
  response: TimelineResponse,
  summary: 'История заказа: события с автором и временем' })

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
