/**
 * Ревизия: ведомость пересчёта и применение результата.
 *
 * ⚠️ Расхождение — это РЕЗУЛЬТАТ ревизии, а не ошибка ввода. Система
 * фиксирует разницу движением kind = 'stocktake', а не перезаписывает
 * количество: физическое наличие — сумма журнала, и затирание истории
 * лишило бы смысла всю модель.
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import * as v from 'valibot'
import { apiError, mapDbError } from '~/kernel/errors'
import { canAccessBranch } from '~/domain/core/auth'
import { applyStocktake, poolDrift, stocktakeSheet, stuckInService } from '~/domain/counter/stocktake'
import { currentShift } from '~/domain/counter/shift'

const Body = v.object({
  branchId: v.pipe(v.string(), v.uuid()),
  categoryCode: v.optional(v.string()),
  /** Пусто — вернуть ведомость. Заполнено — применить пересчёт. */
  counted: v.optional(v.array(v.object({
    variantId: v.pipe(v.string(), v.uuid()),
    actual: v.pipe(v.number(), v.integer(), v.minValue(0)),
  }))),
  reason: v.optional(v.pipe(v.string(), v.maxLength(500))),
  stuckDays: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
})

export interface PostStocktakeRequest {
  body: unknown
}

export async function postStocktake(
  session: Session,
  req: PostStocktakeRequest,
  deps: Deps,
) {
  // Ревизия правит наличие — это уровень админа, не стойки.

  const parsed = v.safeParse(Body, req.body)
  if (!parsed.success) throw apiError('VALIDATION_FAILED', 'Проверьте данные ревизии')
  const input = parsed.output

  if (!canAccessBranch(session, input.branchId)) {
    throw apiError('FORBIDDEN', 'Этот филиал вам недоступен')
  }

  try {
    return await deps.db.tx(session.tenantId, async (c) => {
      if (!input.counted?.length) {
        return {
          sheet: await stocktakeSheet(c, {
            tenantId: session.tenantId,
            branchId: input.branchId,
            categoryCode: input.categoryCode,
          }),
          // Забытое в ремонте — вторая половина сезонной ревизии.
          stuck: await stuckInService(c, {
            tenantId: session.tenantId,
            branchId: input.branchId,
            days: input.stuckDays,
          }),
          // ⚠️ Третья: счётчик пула, разошедшийся с журналом. Он
          // правится из шести мест и расходится молча — витрина тогда
          // недопродаёт парк, ничего об этом не сообщая.
          drift: await poolDrift(c, {
            tenantId: session.tenantId,
            branchIds: input.branchId ? [input.branchId] : undefined,
          }),
        }
      }

      const shift = await currentShift(c, {
        tenantId: session.tenantId,
        branchId: input.branchId,
        staffId: session.activeStaffId,
      })

      return applyStocktake(c, {
        tenantId: session.tenantId,
        branchId: input.branchId,
        staffId: session.activeStaffId,
        shiftId: shift.id,
        counted: input.counted,
        reason: input.reason,
      })
    })
  } catch (err) {
    throw mapDbError(err)
  }
}
