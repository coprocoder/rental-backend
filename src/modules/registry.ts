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

import { registerAccessRoutes, registerAccessAdminRoutes, registerAccessMutations } from './access'
import { registerBookingAdminRoutes, registerBookingMutations, registerBookingPublic, registerBookingRoutes } from './booking'
import { registerCatalogRoutes, registerCatalogAdminRoutes, registerCatalogMutations } from './catalog'
import { registerTenantRoutes, registerTenantAdminRoutes, registerTenantMutations } from './tenant'
import { registerPricingAdminRoutes, registerPricingMutations, registerPricingPublic } from './pricing'
import { registerFittingAdminRoutes, registerFittingMutations } from './fitting'
import { registerAvailabilityAdminRoutes, registerAvailabilityMutations } from './availability'
import { registerCounterMutations, registerCounterPublic, registerCounterRoutes } from './counter'
import { registerPlatformPublic } from './platform'

export function registerModules(app: App, deps: Deps): void {
  registerAccessRoutes(app, deps)
  registerAccessAdminRoutes(app, deps)
  registerAccessMutations(app, deps)
  registerBookingRoutes(app, deps)
  registerBookingAdminRoutes(app, deps)
  registerBookingMutations(app, deps)
  registerCatalogRoutes(app, deps)
  registerCatalogAdminRoutes(app, deps)
  registerCatalogMutations(app, deps)
  registerTenantRoutes(app, deps)
  registerTenantAdminRoutes(app, deps)
  registerTenantMutations(app, deps)
  registerPricingAdminRoutes(app, deps)
  registerPricingMutations(app, deps)
  registerFittingAdminRoutes(app, deps)
  registerFittingMutations(app, deps)
  registerAvailabilityAdminRoutes(app, deps)
  registerAvailabilityMutations(app, deps)
  registerCounterRoutes(app, deps)
  registerCounterMutations(app, deps)
  registerBookingPublic(app, deps)
  registerPricingPublic(app, deps)
  registerPlatformPublic(app, deps)
  registerCounterPublic(app, deps)
}
