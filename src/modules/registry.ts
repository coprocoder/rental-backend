/**
 * Список модулей — ЕДИНСТВЕННОЕ место вне каталога модуля, которое
 * правится при добавлении нового.
 *
 * ⚠️ Явный список, а не автозагрузка каталогов. Автозагрузка выглядит
 * удобнее ровно до первой ошибки: забытый модуль не отличается от
 * сломавшегося, порядок регистрации неявный, а набор маршрутов
 * приложения нельзя прочитать — только выполнить.
 */
import type { App } from '../transport/types'
import type { Deps } from '../kernel/deps'

import { registerAccessRoutes, registerAccessAdminRoutes } from './access'
import { registerBookingRoutes, registerBookingAdminRoutes } from './booking'
import { registerCatalogRoutes, registerCatalogAdminRoutes } from './catalog'
import { registerTenantRoutes, registerTenantAdminRoutes } from './tenant'
import { registerPricingAdminRoutes } from './pricing'
import { registerFittingAdminRoutes } from './fitting'
import { registerAvailabilityAdminRoutes } from './availability'
import { registerCounterRoutes } from './counter'

export function registerModules(app: App, deps: Deps): void {
  registerAccessRoutes(app, deps)
  registerAccessAdminRoutes(app, deps)
  registerBookingRoutes(app, deps)
  registerBookingAdminRoutes(app, deps)
  registerCatalogRoutes(app, deps)
  registerCatalogAdminRoutes(app, deps)
  registerTenantRoutes(app, deps)
  registerTenantAdminRoutes(app, deps)
  registerPricingAdminRoutes(app, deps)
  registerFittingAdminRoutes(app, deps)
  registerAvailabilityAdminRoutes(app, deps)
  registerCounterRoutes(app, deps)
}
