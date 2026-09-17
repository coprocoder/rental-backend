/**
 * Маршруты админки модуля `availability`.
 *
 * ⚠️ Право и тариф — ДВЕ РАЗНЫЕ проверки: «этому сотруднику можно?» и
 * «этот прокат оплатил?». Проверять по отдельности в каждом обработчике
 * — значит однажды забыть вторую и раздать платную функцию бесплатно.
 */
import type { App } from '~/transport/types'
import type { Deps } from '~/kernel/deps'
import * as v from 'valibot'
import { documentRoute } from '~/transport/openapi/registry'
import { SESSION_COOKIE, requirePlanFeature } from '~/kernel/session'
import { getBlackout } from '../service/admin-blackout.service'
import { getOfflineReserve } from '../service/admin-offline-reserve.service'

const OfflineReserveResponse = v.object({
  rows: v.array(v.object({
    branchId: v.pipe(v.string(), v.uuid()),
    branchName: v.string(),
    categoryId: v.pipe(v.string(), v.uuid()),
    categoryName: v.string(),
    /** `percent` — доля склада, `units` — фиксированное число. */
    mode: v.string(),
    value: v.number(),
  })),
})

documentRoute({ method: 'get', path: '/v1/admin/offline-reserve', scope: 'staff',
  response: OfflineReserveResponse,
  summary: 'Резерв под выдачу без брони: сколько держим для улицы' })

const BlackoutResponse = v.object({
  rows: v.array(v.record(v.string(), v.unknown())),
})

documentRoute({ method: 'get', path: '/v1/admin/blackout', scope: 'staff', response: BlackoutResponse,
  summary: 'Периоды, на которые позиция снята с продажи' })

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
