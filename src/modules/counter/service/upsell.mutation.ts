/**
 * Добавить допроданную позицию в заказ (17.21).
 *
 * ⚠️ Цена приходит НЕ из клиента: тело запроса несёт только вариант
 * и количество. Принять сумму с фронта значило бы отдать прайс
 * в руки того, кто стоит за стойкой (железное правило №1).
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import * as v from 'valibot'
import { apiError, mapDbError } from '~/kernel/errors'
import { canAccessBranch } from '~/domain/core/auth'
import { addUpsellLine } from '~/domain/pricing/upsell'
import type { DayMode } from '~/common/contract/day-count'

export const UpsellBody = v.object({
  orderId: v.pipe(v.string(), v.uuid()),
  variantId: v.pipe(v.string(), v.uuid()),
  qty: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(20))),
})

export interface PostUpsellRequest {
  body: unknown
}

export async function postUpsell(
  session: Session,
  req: PostUpsellRequest,
  deps: Deps,
) {

  const parsed = v.safeParse(UpsellBody, req.body)
  if (!parsed.success) throw apiError('VALIDATION_FAILED', 'Проверьте данные')
  const input = parsed.output

  try {
    return await deps.db.tx(session.tenantId, async (c) => {
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
        [input.orderId],
      )
      const cfg = rows[0]
      if (!cfg) throw apiError('NOT_FOUND', 'Заказ не найден')
      if (!canAccessBranch(session, cfg.branch_id)) {
        throw apiError('FORBIDDEN', 'Этот филиал вам недоступен')
      }

      const res = await addUpsellLine(c, {
        tenantId: session.tenantId,
        orderId: input.orderId,
        variantId: input.variantId,
        qty: input.qty ?? 1,
        dayMode: cfg.day_mode,
        timezone: cfg.timezone,
        staffId: session.staffId,
      })
      return { ok: true, ...res }
    })
  } catch (err) {
    throw mapDbError(err)
  }
}
