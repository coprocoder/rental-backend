/**
 * Фасад модуля pricing — ЕДИНСТВЕННОЕ, что видят другие модули.
 *
 * ⚠️ Наружу уходят доменные типы и функции, а не строки таблиц и не
 * gateway целиком. Если сосед привяжется к `{ pool_share_percent, … }`,
 * переименование колонки сломает чужой модуль — ровно та связность,
 * против которой затеяны границы (`plans/01-МОДУЛИ.md`).
 *
 * Владение записью: `price_rule` пишет только этот модуль. Читать его
 * данные соседям можно, писать — нет.
 */
export type { Limits, LimitViolation } from './domain/limits'
export { DEFAULT_LIMITS, allowedShare, checkPoolShare } from './domain/limits'
export { getLimits } from './gateway/limits.gateway'
