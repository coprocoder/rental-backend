/**
 * Публичный контракт модуля доступа: вход, сессии, роли, права.
 *
 * Владение записью: `staff`, `staff_session`, `api_key`, `tenant_flag`.
 */
export { registerAccessRoutes } from './http/access.controller'
export { getMe } from './service/me.service'
export { registerAccessAdminRoutes } from './http/admin.controller'
export { registerAccessMutations } from './http/mutations.controller'
