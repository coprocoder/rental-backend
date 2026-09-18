/**
 * Маршруты админки модуля `catalog`.
 *
 * ⚠️ Право и тариф — ДВЕ РАЗНЫЕ проверки: «этому сотруднику можно?» и
 * «этот прокат оплатил?». Проверять по отдельности в каждом обработчике
 * — значит однажды забыть вторую и раздать платную функцию бесплатно.
 */
import type { App } from '~/transport/types'
import type { Deps } from '~/kernel/deps'
import { SESSION_COOKIE, requirePermission, requirePlanFeature } from '~/kernel/session'
import { getLabels } from '../service/admin-labels.service'
import { getInventory } from '../service/admin-inventory.service'
import { getItems } from '../service/admin-items.service'
import { getService } from '../service/admin-service.service'
import * as v from 'valibot'
import { optionalId, parse } from '~/transport/validate'
import { documentRoute } from '~/transport/openapi/registry'

/**
 * ⚠️ Фильтр по позиции ОБЯЗАН разбираться схемой: браузер шлёт
 * `?variantId=` за незаполненный фильтр, и раньше эта пустая строка
 * уезжала в SQL как UUID — 500 вместо списка.
 */
const ItemsQuery = v.object({
  variantId: optionalId,
  code: v.optional(v.string(), ''),
  // ⚠️ Строка '1', а не булево: это query-параметр, сравнение с '1'
  // живёт в сценарии (`includeArchived: q.archived === '1'`).
  archived: v.optional(v.string(), ''),
})

const InventoryResponse = v.object({
  items: v.array(v.object({
    variantId: v.pipe(v.string(), v.uuid()),
    code: v.string(),
    name: v.string(),
    categoryCode: v.string(),
    categoryName: v.string(),
    branchId: v.pipe(v.string(), v.uuid()),
    branchName: v.string(),
    /** `tracked` — считаем остаток, `unverified` — наличие не проверяем. */
    inventoryMode: v.string(),
    total: v.number(),
    /** Сколько уже забронировано вперёд: показывается предупреждением. */
    bookedAhead: v.number(),
    nearestBookingAt: v.nullable(v.string()),
  })),
})

const ServiceResponse = v.object({
  tasks: v.array(v.object({
    // ⚠️ При количественном учёте вещи нет — есть позиция и число.
    itemId: v.nullable(v.pipe(v.string(), v.uuid())),
    labelCode: v.nullable(v.string()),
    variantId: v.pipe(v.string(), v.uuid()),
    variantName: v.string(),
    categoryName: v.string(),
    branchId: v.pipe(v.string(), v.uuid()),
    branchName: v.string(),
    qty: v.number(),
    serviceKind: v.nullable(v.string()),
    since: v.string(),
    /** Сколько дней в работе: две недели — это уже забытое. */
    days: v.number(),
    qr: v.nullable(v.string()),
  })),
})

const ItemsResponse = v.object({
  // ⚠️ При поиске по номеру (`?code=`) ответ ДРУГОЙ: одна единица
  // вместо списка. Это разные операции — «сколько ботинок 46»
  // и «где вещь BO-0147».
  items: v.optional(v.array(v.record(v.string(), v.unknown()))),
  item: v.optional(v.nullable(v.record(v.string(), v.unknown()))),
  categories: v.optional(v.array(v.object({
    id: v.pipe(v.string(), v.uuid()),
    code: v.string(),
    name: v.string(),
    tracking: v.string(),
    variants: v.number(),
    stock: v.number(),
    items: v.number(),
  }))),
})

documentRoute({ method: 'get', path: '/v1/admin/inventory', scope: 'staff', response: InventoryResponse,
  summary: 'Остатки по позициям: сколько всего и сколько забронировано' })
documentRoute({ method: 'get', path: '/v1/admin/service', scope: 'staff', response: ServiceResponse,
  summary: 'Что сейчас в обслуживании: вещи и позиции, с какого дня' })
documentRoute({ method: 'get', path: '/v1/admin/items', scope: 'staff', response: ItemsResponse,
  summary: 'Единицы инвентаря с номерами; при ?code= — поиск одной по метке' })
/**
 * ⚠️ Отдаёт HTML для печати, а не JSON — поэтому `contentType`. Роут
 * не был описан вовсе: спецификация выглядела полной, потому что
 * недостающими оказались ровно те два роута, которые не возвращают JSON.
 */
documentRoute({ method: 'get', path: '/v1/admin/labels', scope: 'staff',
  response: v.string(), contentType: 'text/html',
  query: ItemsQuery,
  summary: 'Лист этикеток с QR-кодами для печати (HTML, noindex)' })

export function registerCatalogAdminRoutes(app: App, deps: Deps): void {
  app.get('/v1/admin/inventory', async (req) => {
    const s = await requirePermission(req.cookies[SESSION_COOKIE], 'inventory.manage')
    return getInventory(s, req.query as Record<string, unknown>, deps)
  })
  app.get('/v1/admin/items', async (req) => {
    const s = await requirePlanFeature(deps.db, req.cookies[SESSION_COOKIE], 'inventory.manage', 'labeledInventory')
    return getItems(s, parse(ItemsQuery, req.query), deps)
  })
  app.get('/v1/admin/service', async (req) => {
    const s = await requirePermission(req.cookies[SESSION_COOKIE], 'service.record')
    return getService(s, req.query as Record<string, unknown>, deps)
  })

  /**
   * ⚠️ Отдаёт HTML для печати этикеток. `noindex` и `no-store`
   * обязательны: на листе QR-коды инвентаря конкретного проката.
   */
  app.get('/v1/admin/labels', async (httpReq, reply) => {
    const s = await requirePlanFeature(deps.db, httpReq.cookies[SESSION_COOKIE], 'inventory.manage', 'labeledInventory')
    reply.header('content-type', 'text/html; charset=utf-8')
    reply.header('x-robots-tag', 'noindex')
    reply.header('cache-control', 'no-store')
    return getLabels(s, { query: parse(ItemsQuery, httpReq.query) }, deps)
  })
}
