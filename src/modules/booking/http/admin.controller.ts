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
import { OrderDetailSchema } from '~/transport/schemas/order-detail'
import { SESSION_COOKIE, requirePermission, requireSession } from '~/kernel/session'
import { getWaitlist } from '../service/admin-waitlist.service'
import { getOrders } from '../service/admin-orders.service'
import { getOrderDetail, getOrderTimeline } from '../service/order-detail.service'

/**
 * Запись листа ожидания.
 *
 * ⚠️ Форма взята из ЗАПРОСА (`getWaitlist`) и обнуляемость — из схемы
 * БД (`information_schema`), а НЕ из ответа: на стенде лист ожидания
 * пуст, и раньше здесь стояло `record(string, unknown)` с пометкой
 * «уточнить, когда появится образец». Пустой стенд — не повод
 * оставлять поле неописанным: SQL перечисляет колонки буквально, и это
 * такой же факт, как ответ. Экран уже читал `customer_name` и
 * `phone_tail`, а тип выводился как `{ n: number }` — из полей,
 * которые экран добавляет сам.
 *
 * ⚠️ Поля в `snake_case`: строки отдаются как пришли из запроса, без
 * переименования. Приводить их к `camelCase` здесь значило бы менять
 * ответ ради красоты схемы — это правка контракта, а не документации.
 */
const WaitlistEntry = v.object({
  id: v.pipe(v.string(), v.uuid()),
  status: v.string(),
  created_at: v.string(),
  expires_at: v.string(),
  notified_at: v.nullable(v.string()),
  wants_from: v.string(),
  wants_to: v.string(),
  /**
   * ⚠️ Гибкость видна сотруднику (17.14): «взял бы любой день» и
   * «нужна именно суббота» — разный дефицит. `null`, когда клиент
   * не указал окно поиска (`search_period` обнуляем).
   */
  search_from: v.nullable(v.string()),
  search_to: v.nullable(v.string()),
  variant_code: v.string(),
  variant_name: v.string(),
  category_code: v.string(),
  /** Имя клиента обнуляемо: запись возможна по одному телефону. */
  customer_name: v.nullable(v.string()),
  /** Последние 4 цифры, не весь номер: списку хватает для узнавания. */
  phone_tail: v.string(),
  /**
   * ⭐ Главная ценность листа — не контакты, а параметры тела:
   * «ждут 4 человека роста 175–182 на сноуборд 157» — готовый ввод
   * для решения о закупке.
   */
  body_params: v.nullable(v.record(v.string(), v.unknown())),
  branch_name: v.string(),
})

const WaitlistResponse = v.object({
  entries: v.array(WaitlistEntry),
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

/**
 * ⚠️ Схема карточки заказа вынесена в `transport/schemas/order-detail`:
 * тот же объект отдаёт и стойка (`/v1/counter/orders/:id`), и две схемы
 * на один источник уже разошлись — здесь строки были описаны по полям,
 * там как `record(string, unknown)`.
 */
const OrderCardResponse = OrderDetailSchema

const TimelineResponse = v.object({
  /**
   * История заказа: что, когда и кто сделал. Форма — из типа домена
   * `OrderTimelineEntry`, сверена с ответом.
   */
  timeline: v.array(v.object({
    kind: v.string(),
    occurredAt: v.string(),
    actorType: v.nullable(v.string()),
    actorName: v.nullable(v.string()),
    payload: v.record(v.string(), v.unknown()),
    /**
     * ⚠️ Причина — только у ручных вмешательств, поэтому в ответе она
     * сплошь `null`. Тип взят из домена, а не из ответа: описать поле
     * как «всегда null» значило бы сломать экран на первом же
     * вмешательстве с причиной.
     */
    reason: v.nullable(v.string()),
  })),
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
