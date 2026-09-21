/**
 * Публичный контракт модуля проката: настройки, сотрудники, филиалы, тариф.
 *
 * Владение записью: `tenant`, `tenant_text`, `branch`, `schedule`.
 */
export { registerTenantRoutes } from './http/tenant.controller'
export {
  getBranches, getPlan, getStaff, getTheme, getToday,
} from './service/tenant.service'
export { registerTenantAdminRoutes } from './http/admin.controller'
export { registerTenantMutations } from './http/mutations.controller'
