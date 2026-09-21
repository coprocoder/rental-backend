/**
 * Маршруты стойки: выдача, возврат, смена, ревизия.
 *
 * ⚠️ Все требуют только ВХОДА, без отдельного права: стойка — рабочее
 * место, и сотрудник за ней уже прошёл проверку при входе.
 */
import type { App } from '~/transport/types'
import type { Deps } from '~/kernel/deps'
import { documentRoute } from '~/transport/openapi/registry'
import { SESSION_COOKIE, requireSession } from '~/kernel/session'
import { getCatalog } from '../service/catalog.service'
import { getFreeItems } from '../service/free-items.service'
import { getHistory } from '../service/history.service'
import { getItemLookup } from '../service/item-lookup.service'
import { getOrders } from '../service/orders.service'
import { getShift } from '../service/shift.service'
import { getUpsell } from '../service/upsell.service'
import * as v from 'valibot'
import { optionalId, parse } from '~/transport/validate'

/**
 * ⚠️ `?branchId=` (пустой фильтр филиала) уезжал в SQL как UUID и ронял
 * экран стойки в 500. Пустая строка была ещё и falsy, поэтому проверку
 * доступа к филиалу проскакивала молча — отказ приходил уже из базы.
 */
const OrdersQuery = v.object({
  branchId: optionalId,
  q: v.optional(v.string()),
  // ⚠️ Сравнение с 'false' остаётся в сценарии: умолчание «сегодня».
  today: v.optional(v.string()),
})

const CounterCatalogResponse = v.object({
  branches: v.array(v.object({
    id: v.pipe(v.string(), v.uuid()),
    name: v.string(),
    timezone: v.string(),
  })),
  // ⚠️ Поля в snake_case: слой отдаёт строки БД как есть. Схема
  // описывает реальность, а не желаемое — переименование это отдельная
  // правка с версией API.
  variants: v.array(v.object({
    id: v.pipe(v.string(), v.uuid()),
    code: v.string(),
    name: v.string(),
    branch_id: v.pipe(v.string(), v.uuid()),
    category_code: v.string(),
    category_name: v.string(),
  })),
})

documentRoute({ method: 'get', path: '/v1/counter/catalog', scope: 'staff',
  response: CounterCatalogResponse,
  summary: 'Каталог для стойки: позиции, доступные к выдаче без брони' })

const CounterOrdersResponse = v.object({
  orders: v.array(v.object({
    id: v.pipe(v.string(), v.uuid()),
    publicCode: v.string(),
    status: v.string(),
    customerName: v.nullable(v.string()),
    // ⚠️ Только хвост телефона: на стойке экран видит очередь,
    // а полный номер там не нужен. `null` у выдачи без брони —
    // там клиента не записывают вовсе.
    phoneTail: v.nullable(v.string()),
    startsAt: v.string(),
    endsAt: v.string(),
    total: v.nullable(v.string()),
    lines: v.number(),
  })),
})

const FreeItemsResponse = v.object({
  items: v.array(v.record(v.string(), v.unknown())),
  /** Ведётся ли позиция поимённо: от этого зависит форма выдачи. */
  labeled: v.optional(v.boolean()),
})

const ItemLookupResponse = v.object({
  /** null — метка чужая или стёртая. Это нормальный ответ скана. */
  item: v.nullable(v.record(v.string(), v.unknown())),
})

const HistoryResponse = v.object({
  history: v.nullable(v.object({
    rentalCount: v.number(),
    lastRentalAt: v.nullable(v.string()),
    /** Что брал в прошлый раз: подставляется на стойке. */
    /** Что брал в прошлый раз: подставляется на стойке. */
    previousItems: v.array(v.object({
      variantId: v.pipe(v.string(), v.uuid()),
      variantName: v.string(),
      categoryName: v.string(),
      labelCode: v.nullable(v.string()),
    })),
    /**
     * ⚠️ Прошлое значение DIN — ПОДСКАЗКА, а не значение: техник
     * обязан проверить заново (железное правило 7). Поэтому рядом
     * хранится и кто выставил.
     */
    lastDin: v.nullable(v.object({
      value: v.string(),
      verifiedBy: v.nullable(v.string()),
    })),
    bodyParams: v.nullable(v.record(v.string(), v.unknown())),
  })),
  /**
   * Рекомендация DIN — РАБОТА ДЛЯ ТЕХНИКА, а не готовое значение
   * (железное правило 7). Фактическое значение и кто проверил идут
   * на заказ отдельно.
   */
  din: v.nullable(v.object({
    code: v.string(),
    /** ⚠️ Диапазон, а не точка: точную цифру выставляет техник. */
    range: v.nullable(v.tuple([v.number(), v.number()])),
    chartVersion: v.string(),
    /** Почему получился такой код — техник должен видеть основание. */
    why: v.array(v.string()),
    /** Чего не хватает для расчёта. */
    missing: v.array(v.string()),
    /** Куда двигаться внутри диапазона с учётом подошвы. */
    bslHint: v.nullable(v.string()),
  })),
})

const UpsellResponse = v.object({
  // ⚠️ Не больше трёх и не модально — требование ТЗ: список из
  // пятнадцати позиций в спешке пролистывают не читая.
  items: v.array(v.object({
    variantId: v.pipe(v.string(), v.uuid()),
    name: v.string(),
    /** Почему предлагаем именно это. */
    why: v.optional(v.string()),
    amount: v.string(),
  })),
})

const ShiftResponse = v.object({
  /** null — сотрудник не привязан к филиалу: смены без точки не бывает. */
  branchId: v.nullable(v.pipe(v.string(), v.uuid())),
  shift: v.nullable(v.object({
    id: v.pipe(v.string(), v.uuid()),
    openedAt: v.string(),
    /** Смена завелась сама при первой операции, а не открыта человеком. */
    isImplicit: v.boolean(),
    issued: v.number(),
    returned: v.number(),
    /** Выдано и ещё не вернулось. */
    outstanding: v.number(),
    overdue: v.number(),
    cashOpen: v.nullable(v.string()),
  })),
  // ⚠️ Приходит только при открытой смене: сводка дня с кассой отдаётся
  // вместе со сменой, чтобы передача была одним экраном.
  day: v.optional(v.nullable(v.object({
    revenue: v.string(),
    orders: v.number(),
    issued: v.number(),
    returned: v.number(),
    cashOpen: v.nullable(v.string()),
    cashExpected: v.nullable(v.string()),
    /** Расхождение кассы: то, ради чего смену и сверяют. */
    cashDiff: v.nullable(v.string()),
    /**
     * Что сломалось за смену — это и есть передача: вечерний сотрудник
     * должен узнать о поломках, не читая журнал целиком.
     *
     * ⚠️ Форма из типа домена (`shift.ts`), а не из ответа: на стенде
     * смена закрыта, и `day` приходит `null`. Здесь стояло
     * `record(string, unknown)`, из-за чего экран смены не мог
     * отформатировать `i.at` — время события приходило как `unknown`.
     */
    incidents: v.array(v.object({
      kind: v.string(),
      at: v.string(),
      note: v.nullable(v.string()),
    })),
  }))),
})

documentRoute({ method: 'get', path: '/v1/counter/orders', scope: 'staff',
  response: CounterOrdersResponse, summary: 'Очередь стойки: заказы на выдачу и возврат' })
documentRoute({ method: 'get', path: '/v1/counter/free-items', scope: 'staff',
  response: FreeItemsResponse, summary: 'Свободные единицы позиции для выдачи сейчас' })
documentRoute({ method: 'get', path: '/v1/counter/item-lookup', scope: 'staff',
  response: ItemLookupResponse, summary: 'Поиск вещи по номеру метки — скан на стойке' })
documentRoute({ method: 'get', path: '/v1/counter/history', scope: 'staff',
  response: HistoryResponse, summary: 'История клиента и рекомендация DIN для заказа' })
documentRoute({ method: 'get', path: '/v1/counter/upsell', scope: 'staff',
  response: UpsellResponse, summary: 'Что предложить клиенту дополнительно при выдаче' })
documentRoute({ method: 'get', path: '/v1/counter/shift', scope: 'staff',
  response: ShiftResponse, summary: 'Открытая смена филиала и сводка дня' })

export function registerCounterRoutes(app: App, deps: Deps): void {
  app.get('/v1/counter/catalog', async (req) => {
    const s = await requireSession(req.cookies[SESSION_COOKIE])
    return getCatalog(s, req.query as Record<string, unknown>, deps)
  })
  app.get('/v1/counter/free-items', async (req) => {
    const s = await requireSession(req.cookies[SESSION_COOKIE])
    return getFreeItems(s, req.query as Record<string, unknown>, deps)
  })
  app.get('/v1/counter/history', async (req) => {
    const s = await requireSession(req.cookies[SESSION_COOKIE])
    return getHistory(s, req.query as Record<string, unknown>, deps)
  })
  app.get('/v1/counter/item-lookup', async (req) => {
    const s = await requireSession(req.cookies[SESSION_COOKIE])
    return getItemLookup(s, req.query as Record<string, unknown>, deps)
  })
  app.get('/v1/counter/orders', async (req) => {
    const s = await requireSession(req.cookies[SESSION_COOKIE])
    return getOrders(s, parse(OrdersQuery, req.query), deps)
  })
  app.get('/v1/counter/shift', async (req) => {
    const s = await requireSession(req.cookies[SESSION_COOKIE])
    return getShift(s, req.query as Record<string, unknown>, deps)
  })
  app.get('/v1/counter/upsell', async (req) => {
    const s = await requireSession(req.cookies[SESSION_COOKIE])
    return getUpsell(s, req.query as Record<string, unknown>, deps)
  })
}
