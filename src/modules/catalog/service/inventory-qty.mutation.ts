/**
 * Правка количества инвентаря в один шаг.
 *
 * ⚠️ Один запрос без открытия карточки (13.5.1): если для «привезли
 * ещё два борда» нужна форма, склад не будет обновляться, и наличие
 * разойдётся с реальностью.
 *
 * ⚠️ При уменьшении причина обязательна — проверяется в домене.
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import * as v from 'valibot'
import { apiError, mapDbError } from '~/kernel/errors'
import { canAccessBranch } from '~/domain/core/auth'
import { adjustQuantity } from '~/domain/admin/admin'
import { currentShift } from '~/domain/counter/shift'

export const InventoryQtyBody = v.object({
  branchId: v.pipe(v.string(), v.uuid()),
  /** Одна позиция или сразу несколько — «все ботинки +1» (13.5.2). */
  items: v.pipe(v.array(v.object({
    variantId: v.pipe(v.string(), v.uuid()),
    delta: v.pipe(v.number(), v.integer()),
  })), v.minLength(1), v.maxLength(200)),
  reason: v.optional(v.pipe(v.string(), v.maxLength(500))),
})

export interface PostInventoryQtyRequest {
  body: unknown
}

export async function postInventoryQty(
  session: Session,
  req: PostInventoryQtyRequest,
  deps: Deps,
) {

  const parsed = v.safeParse(InventoryQtyBody, req.body)
  if (!parsed.success) throw apiError('VALIDATION_FAILED', 'Проверьте данные')
  const input = parsed.output

  if (!canAccessBranch(session, input.branchId)) {
    throw apiError('FORBIDDEN', 'Этот филиал вам недоступен')
  }

  try {
    return await deps.db.tx(session.tenantId, async (c) => {
      const shift = await currentShift(c, {
        tenantId: session.tenantId,
        branchId: input.branchId,
        staffId: session.activeStaffId,
      })

      const results = []
      for (const item of input.items) {
        const r = await adjustQuantity(c, {
          tenantId: session.tenantId,
          branchId: input.branchId,
          variantId: item.variantId,
          delta: item.delta,
          staffId: session.activeStaffId,
          reason: input.reason,
          shiftId: shift.id,
        })
        results.push({ variantId: item.variantId, ...r })
      }
      return { results }
    })
  } catch (err) {
    throw mapDbError(err)
  }
}
