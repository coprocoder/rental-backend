/**
 * Маршруты админки модуля `availability`.
 *
 * ⚠️ Право и тариф — ДВЕ РАЗНЫЕ проверки: «этому сотруднику можно?» и
 * «этот прокат оплатил?». Проверять по отдельности в каждом обработчике
 * — значит однажды забыть вторую и раздать платную функцию бесплатно.
 */
import type { App } from '~/transport/types'
import type { Deps } from '~/kernel/deps'
import { SESSION_COOKIE, requirePlanFeature } from '~/kernel/session'
import { getBlackout } from '../service/admin-blackout.service'
import { getOfflineReserve } from '../service/admin-offline-reserve.service'

export function registerAvailabilityAdminRoutes(app: App, deps: Deps): void {
  app.get('/v1/admin/blackout', async (req) => {
    const s = await requirePlanFeature(deps.db, req.cookies[SESSION_COOKIE], 'inventory.manage', 'advancedInventory')
    return getBlackout(s, req.query as Record<string, unknown>, deps)
  })
  app.get('/v1/admin/offline-reserve', async (req) => {
    const s = await requirePlanFeature(deps.db, req.cookies[SESSION_COOKIE], 'inventory.manage', 'advancedInventory')
    return getOfflineReserve(s, req.query as Record<string, unknown>, deps)
  })
}
