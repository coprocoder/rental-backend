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
import { getInventory } from '../service/admin-inventory.service'
import { getItems } from '../service/admin-items.service'
import { getService } from '../service/admin-service.service'

export function registerCatalogAdminRoutes(app: App, deps: Deps): void {
  app.get('/v1/admin/inventory', async (req) => {
    const s = await requirePermission(req.cookies[SESSION_COOKIE], 'inventory.manage')
    return getInventory(s, req.query as Record<string, unknown>, deps)
  })
  app.get('/v1/admin/items', async (req) => {
    const s = await requirePlanFeature(deps.db, req.cookies[SESSION_COOKIE], 'inventory.manage', 'labeledInventory')
    return getItems(s, req.query as Record<string, unknown>, deps)
  })
  app.get('/v1/admin/service', async (req) => {
    const s = await requirePermission(req.cookies[SESSION_COOKIE], 'service.record')
    return getService(s, req.query as Record<string, unknown>, deps)
  })
}
