/**
 * Отметить выдачу.
 *
 * ⚠️ Расхождение наличия НЕ мешает выдаче: возвращается список
 * расхождений, операция проходит. Наличие — оценка, а не истина
 * (железное правило №12).
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import * as v from 'valibot'
import { apiError, mapDbError } from '~/kernel/errors'
import { issueOrder } from '~/domain/counter/counter'

export const IssueBody = v.object({
  orderId: v.pipe(v.string(), v.uuid()),
  lines: v.pipe(v.array(v.object({
    orderLineId: v.pipe(v.string(), v.uuid()),
    qty: v.pipe(v.number(), v.integer(), v.minValue(1)),
    bslMm: v.optional(v.pipe(v.number(), v.minValue(200), v.maxValue(400))),
    dinRecommended: v.optional(v.pipe(v.number(), v.minValue(0.5), v.maxValue(20))),
    dinActual: v.optional(v.pipe(v.number(), v.minValue(0.5), v.maxValue(20))),
    /**
     * Конкретные вещи при поимённом учёте — по одной на единицу.
     * ⚠️ Домену безразлично, как их указали: сканом, руками или
     * выбором из списка. Сюда приходят уже id.
     */
    itemIds: v.optional(v.array(v.pipe(v.string(), v.uuid()))),
  })), v.minLength(1)),
  reason: v.optional(v.pipe(v.string(), v.maxLength(500))),
})

export interface PostIssueRequest {
  body: unknown
}

export async function postIssue(
  session: Session,
  req: PostIssueRequest,
  deps: Deps,
) {
  // Выдача при расхождении — полномочие стойки: клиент стоит, надо решать.

  const parsed = v.safeParse(IssueBody, req.body)
  if (!parsed.success) throw apiError('VALIDATION_FAILED', 'Проверьте данные выдачи')

  try {
    return await deps.db.tx(session.tenantId, (c) => issueOrder(c, {
      tenantId: session.tenantId,
      orderId: parsed.output.orderId,
      // ⚠️ АКТИВНЫЙ сотрудник, а не владелец сессии: после
      // PIN-переключения подпись DIN должна стоять того, кто проверил.
      staffId: session.activeStaffId,
      lines: parsed.output.lines,
      reason: parsed.output.reason,
    }))
  } catch (err) {
    throw mapDbError(err)
  }
}
