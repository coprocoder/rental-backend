/**
 * Открытие и закрытие смены.
 *
 * ⚠️ Смена НЕ обязательна: операции привязываются к неявной смене
 * автоматически. Этот эндпоинт нужен для сверки кассы — сколько было
 * в ящике на начало и на конец.
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import * as v from 'valibot'
import { apiError, mapDbError } from '~/kernel/errors'
import { canAccessBranch } from '~/domain/core/auth'
import { closeShift, openShift, shiftSummary } from '~/domain/counter/shift'

const Body = v.variant('action', [
  v.object({
    action: v.literal('open'),
    branchId: v.pipe(v.string(), v.uuid()),
    cashOpen: v.optional(v.pipe(v.string(), v.regex(/^\d+(\.\d{1,2})?$/))),
  }),
  v.object({
    action: v.literal('close'),
    shiftId: v.pipe(v.string(), v.uuid()),
    cashClose: v.optional(v.pipe(v.string(), v.regex(/^\d+(\.\d{1,2})?$/))),
    note: v.optional(v.pipe(v.string(), v.maxLength(500))),
  }),
])

export interface PostShiftRequest {
  body: unknown
}

export async function postShift(
  session: Session,
  req: PostShiftRequest,
  deps: Deps,
) {

  const parsed = v.safeParse(Body, req.body)
  if (!parsed.success) throw apiError('VALIDATION_FAILED', 'Проверьте данные смены')
  const input = parsed.output

  try {
    return await deps.db.tx(session.tenantId, async (c) => {
      if (input.action === 'open') {
        if (!canAccessBranch(session, input.branchId)) {
          throw apiError('FORBIDDEN', 'Этот филиал вам недоступен')
        }
        const result = await openShift(c, {
          tenantId: session.tenantId,
          branchId: input.branchId,
          staffId: session.activeStaffId,
          cashOpen: input.cashOpen,
        })
        return { ...result, summary: await shiftSummary(c, result.id) }
      }

      // Перед закрытием отдаём сводку: это и есть передача смены —
      // вечерний сотрудник видит, что осталось от утреннего.
      const summary = await shiftSummary(c, input.shiftId)
      await closeShift(c, {
        shiftId: input.shiftId,
        staffId: session.activeStaffId,
        cashClose: input.cashClose,
        note: input.note,
      })
      return { closed: true, summary }
    })
  } catch (err) {
    throw mapDbError(err)
  }
}
