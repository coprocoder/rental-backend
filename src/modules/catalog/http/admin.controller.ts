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
