/**
 * Мутации модуля `catalog`.
 *
 * ⚠️ Право и тариф — ДВЕ РАЗНЫЕ проверки, и для мутаций цена ошибки
 * выше, чем для чтения: забытая проверка тарифа раздаёт платную
 * функцию, забытое право — доступ к чужим действиям.
 */
import type { App } from '~/transport/types'
import type { Deps } from '~/kernel/deps'
import * as v from 'valibot'
import { documentRoute } from '~/transport/openapi/registry'
import { SESSION_COOKIE, requirePermission, requirePlanFeature } from '~/kernel/session'
import { postBulk, BulkBody } from '../service/bulk.mutation'
import { postCatalogItem, CatalogItemBody } from '../service/catalog-item.mutation'
import { postDemo, DemoBody } from '../service/demo.mutation'
import { postInventoryQty, InventoryQtyBody } from '../service/inventory-qty.mutation'
import { postItems, ItemsBody } from '../service/items.mutation'
import { postService, ServiceBody } from '../service/service.mutation'
import { InventoryItemSchema } from './admin.controller'

/**
 * ⚠️ Схемы ТЕЛ импортируются из сервисов — там они уже написаны и ими
 * же валидируется запрос. Копия здесь стала бы третьей правдой.
 */

documentRoute({ method: 'post', path: '/v1/admin/bulk', scope: 'staff',
  body: BulkBody,
  /**
   * ⚠️ Два разных ответа по режиму: `preview` показывает, ЧТО попадёт
   * под операцию (список позиций), `apply` — сколько затронуто.
   * Предпросмотр отдельным режимом, а не отдельным роутом: массовая
   * операция без «покажи, что будет» — это списание вслепую.
   */
  response: v.union([
    v.object({
      affected: v.array(v.object({
        variantId: v.pipe(v.string(), v.uuid()),
        code: v.string(),
        name: v.string(),
        categoryName: v.string(),
        branchName: v.string(),
        total: v.number(),
        /** Сколько занято бронями вперёд — предупреждение при списании. */
        bookedAhead: v.number(),
      })),
    }),
    v.object({ affected: v.number() }),
  ]),
  summary: 'Массовые операции над позициями: предпросмотр и применение' })

documentRoute({ method: 'post', path: '/v1/admin/catalog-item', scope: 'staff',
  body: CatalogItemBody,
  response: v.object({ id: v.pipe(v.string(), v.uuid()) }),
  summary: 'Позиция каталога: категория, вариант и стартовая цена одной формой' })

documentRoute({ method: 'post', path: '/v1/admin/demo', scope: 'staff',
  body: DemoBody,
  response: v.object({ variants: v.number() }),
  summary: 'Демо-инвентарь для нового проката: типовые категории и размеры' })

documentRoute({ method: 'post', path: '/v1/admin/inventory-qty', scope: 'staff',
  body: InventoryQtyBody,
  response: v.object({
    results: v.array(v.object({
      variantId: v.pipe(v.string(), v.uuid()),
      newTotal: v.number(),
    })),
  }),
  summary: 'Приход и списание по количеству, без поимённого учёта' })

documentRoute({ method: 'post', path: '/v1/admin/items', scope: 'staff',
  body: ItemsBody,
  /**
   * ⚠️ ШЕСТЬ форм ответа по действию — это не разнобой, а разные
   * операции под одним роутом: завести единицы, переименовать метку,
   * архивировать одну или список, отключить на даты, снять отключение,
   * переключить учёт категории.
   */
  response: v.union([
    v.object({ created: v.array(InventoryItemSchema) }),
    v.object({ labelCode: v.string() }),
    v.object({ archived: v.array(v.string()), skipped: v.array(v.string()) }),
    v.object({ affected: v.number() }),
    v.object({ cleared: v.number() }),
    v.object({ tracking: v.string(), itemsCreated: v.number() }),
  ]),
  summary: 'Единицы инвентаря: завести, пометить, архивировать, отключить на даты' })

documentRoute({ method: 'post', path: '/v1/admin/service', scope: 'staff',
  body: ServiceBody,
  response: v.object({ returned: v.number() }),
  summary: 'Обслуживание: отправить в ремонт и вернуть в строй' })

export function registerCatalogMutations(app: App, deps: Deps): void {
  app.post('/v1/admin/bulk', async (httpReq) => {
    const s = await requirePlanFeature(deps.db, httpReq.cookies[SESSION_COOKIE], 'inventory.manage', 'advancedInventory')
    return postBulk(s, { body: httpReq.body }, deps)
  })
  app.post('/v1/admin/catalog-item', async (httpReq) => {
    const s = await requirePermission(httpReq.cookies[SESSION_COOKIE], 'price.manage')
    return postCatalogItem(s, { body: httpReq.body }, deps)
  })
  app.post('/v1/admin/demo', async (httpReq) => {
    const s = await requirePermission(httpReq.cookies[SESSION_COOKIE], 'inventory.manage')
    return postDemo(s, { body: httpReq.body }, deps)
  })
  app.post('/v1/admin/inventory-qty', async (httpReq) => {
    const s = await requirePermission(httpReq.cookies[SESSION_COOKIE], 'inventory.manage')
    return postInventoryQty(s, { body: httpReq.body }, deps)
  })
  app.post('/v1/admin/items', async (httpReq) => {
    const s = await requirePlanFeature(deps.db, httpReq.cookies[SESSION_COOKIE], 'inventory.manage', 'labeledInventory')
    return postItems(s, { body: httpReq.body }, deps)
  })
  app.post('/v1/admin/service', async (httpReq) => {
    const s = await requirePermission(httpReq.cookies[SESSION_COOKIE], 'service.record')
    return postService(s, { body: httpReq.body }, deps)
  })
}
