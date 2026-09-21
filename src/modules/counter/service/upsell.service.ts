/**
 * Что предложить к заказу на стойке (17.21).
 *
 * ⚠️ Не более трёх и только по опубликованному прайсу — причины
 * в server/domain/upsell.ts. Здесь эндпоинт лишь отдаёт готовое:
 * своей цены на стойке не бывает.
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import { apiError } from '~/kernel/errors'
import { canAccessBranch } from '~/domain/core/auth'
import { upsellFor } from '~/domain/pricing/upsell'
import type { DayMode } from '~/common/contract/day-count'

export async function getUpsell(
  session: Session,
  input: Record<string, unknown>,
  deps: Deps,
) {
  const orderId = String(input.orderId ?? '')
  if (!orderId) throw apiError('VALIDATION_FAILED', 'Не указан заказ')

  return deps.db.tx(session.tenantId, async (c) => {
    const { rows } = await c.query<{
      branch_id: string
      day_mode: DayMode
      timezone: string
    }>(
      `SELECT o.branch_pickup_id AS branch_id, t.day_mode, b.timezone
       FROM rental_order o
       JOIN branch b ON b.id = o.branch_pickup_id
       JOIN tenant t ON t.id = o.tenant_id
       WHERE o.id = $1`,
      [orderId],
    )
    const cfg = rows[0]
    if (!cfg) throw apiError('NOT_FOUND', 'Заказ не найден')
    if (!canAccessBranch(session, cfg.branch_id)) {
      throw apiError('FORBIDDEN', 'Этот филиал вам недоступен')
    }

    return {
      items: await upsellFor(c, {
        tenantId: session.tenantId,
        orderId,
        branchId: cfg.branch_id,
        dayMode: cfg.day_mode,
        timezone: cfg.timezone,
      }),
    }
  })
}
