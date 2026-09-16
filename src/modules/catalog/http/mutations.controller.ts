/**
 * Мутации модуля `catalog`.
 *
 * ⚠️ Право и тариф — ДВЕ РАЗНЫЕ проверки, и для мутаций цена ошибки
 * выше, чем для чтения: забытая проверка тарифа раздаёт платную
 * функцию, забытое право — доступ к чужим действиям.
 */
import type { App } from '~/transport/types'
import type { Deps } from '~/kernel/deps'
import { SESSION_COOKIE, requirePermission, requirePlanFeature } from '~/kernel/session'
import { postBulk } from '../service/bulk.mutation'
import { postCatalogItem } from '../service/catalog-item.mutation'
import { postDemo } from '../service/demo.mutation'
import { postInventoryQty } from '../service/inventory-qty.mutation'
import { postItems } from '../service/items.mutation'
import { postService } from '../service/service.mutation'

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
