/**
 * Настройки лимитов бронирования тенанта.
 *
 * ⚠️ В Nuxt-версии чтение и правила лежали в одном файле
 * (`server/domain/pricing/limits.ts`): SQL, значения по умолчанию и
 * проверки долей вперемешку. Здесь чтение отделено от правил — правила
 * в `../domain/limits.ts`, и они тестируются без базы.
 */
import type { PoolClient } from 'pg'
import type { Limits } from '../domain/limits'
import { DEFAULT_LIMITS } from '../domain/limits'

/** Настройки тенанта. Отсутствие строки — значения по умолчанию. */
export async function getLimits(c: PoolClient, tenantId: string): Promise<Limits> {
  const { rows } = await c.query<{
    pool_share_percent: number
    max_active_orders: number
    max_advance_days: number
    confirm_deadline_hours: number
    hold_minutes: number
  }>(
    `SELECT pool_share_percent, max_active_orders, max_advance_days,
            confirm_deadline_hours, hold_minutes
     FROM booking_limit WHERE tenant_id = $1`,
    [tenantId],
  )
  const r = rows[0]
  if (!r) return DEFAULT_LIMITS

  return {
    poolSharePercent: r.pool_share_percent,
    maxActiveOrders: r.max_active_orders,
    maxAdvanceDays: r.max_advance_days,
    confirmDeadlineHours: r.confirm_deadline_hours,
    holdMinutes: r.hold_minutes,
  }
}
