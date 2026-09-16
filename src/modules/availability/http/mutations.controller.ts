/**
 * Мутации модуля `availability`.
 *
 * ⚠️ Право и тариф — ДВЕ РАЗНЫЕ проверки, и для мутаций цена ошибки
 * выше, чем для чтения: забытая проверка тарифа раздаёт платную
 * функцию, забытое право — доступ к чужим действиям.
 */
import type { App } from '~/transport/types'
import type { Deps } from '~/kernel/deps'
import { SESSION_COOKIE, requirePlanFeature } from '~/kernel/session'
import { postBlackout } from '../service/blackout.mutation'
import { postOfflineReserve } from '../service/offline-reserve.mutation'

export function registerAvailabilityMutations(app: App, deps: Deps): void {
  app.post('/v1/admin/blackout', async (httpReq) => {
    const s = await requirePlanFeature(deps.db, httpReq.cookies[SESSION_COOKIE], 'inventory.manage', 'advancedInventory')
    return postBlackout(s, { body: httpReq.body }, deps)
  })
  app.post('/v1/admin/offline-reserve', async (httpReq) => {
    const s = await requirePlanFeature(deps.db, httpReq.cookies[SESSION_COOKIE], 'inventory.manage', 'advancedInventory')
    return postOfflineReserve(s, { body: httpReq.body }, deps)
  })
}
