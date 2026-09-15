/**
 * Типы модуля цен и лимитов.
 */

/** Настройки лимитов бронирования тенанта. */
export interface Limits {
  poolSharePercent: number
  maxActiveOrders: number
  maxAdvanceDays: number
  confirmDeadlineHours: number
  holdMinutes: number
}

/**
 * Нарушение лимита — с числами, достаточными для сообщения клиенту.
 *
 * ⚠️ Размеченное объединение, а не булево: «нельзя» без объяснения
 * заставляет клиента угадывать, а прокат — разбираться в поддержке.
 */
export type LimitViolation =
  | { kind: 'pool_share', variantId: string, requested: number, allowed: number, capacity: number }
  | { kind: 'active_orders', current: number, allowed: number }
  | { kind: 'advance_days', requested: number, allowed: number }

/** Строка настроек лимитов как её отдаёт Postgres. */
export interface BookingLimitRow {
  pool_share_percent: number
  max_active_orders: number
  max_advance_days: number
  confirm_deadline_hours: number
  hold_minutes: number
}
