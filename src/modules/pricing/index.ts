/**
 * Публичный контракт модуля цен и лимитов.
 *
 * ⚠️ Это ЕДИНСТВЕННОЕ, что видят соседние модули. Всё остальное внутри
 * каталога — их частное дело: `database/` не импортируется никем снаружи,
 * и проверяет это правило `module-private-internals` в CI.
 *
 * ⚠️ Наружу уходят доменные типы, а не строки таблиц. Если сосед
 * привяжется к `{ pool_share_percent, … }`, переименование колонки
 * сломает чужой модуль — ровно та связность, против которой затеяны
 * границы.
 *
 * Владение записью: `price_rule` пишет ТОЛЬКО этот модуль. Читать его
 * данные соседям можно, писать — нет.
 */
export type { Limits, LimitViolation } from './pricing.types'
export { DEFAULT_LIMITS, allowedShare, checkPoolShare } from './domain/limits'
export { getLimits } from './database/limits.repository'
export { registerPricingAdminRoutes } from './http/admin.controller'
export { registerPricingMutations } from './http/mutations.controller'
export { registerPricingPublic } from './http/public.controller'
