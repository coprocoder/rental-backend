/**
 * Нештатные ситуации на стойке: неявка, передача, списание, просрочка.
 *
 * Собраны в один эндпоинт по действию, потому что все они — ручные
 * вмешательства оператора с причиной, и разграничение у них по
 * полномочиям, а не по механике.
 *
 * ⚠️ Каждое действие требует своего полномочия: стойка решает вопросы
 * очереди (неявка, передача), а списание инвентаря — уровень админа.
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import * as v from 'valibot'
import { apiError, mapDbError } from '~/kernel/errors'
import { canAccessBranch, can } from '~/domain/core/auth'
import { markNoShow, overdueCharge, transferOrder, writeOffVariant } from '~/domain/core/exceptions'

export const IncidentBody = v.variant('action', [
  v.object({
    action: v.literal('no_show'),
    orderId: v.pipe(v.string(), v.uuid()),
    reason: v.optional(v.pipe(v.string(), v.maxLength(500))),
  }),
  v.object({
    action: v.literal('transfer'),
    orderId: v.pipe(v.string(), v.uuid()),
    newPhone: v.pipe(v.string(), v.minLength(5), v.maxLength(30)),
    newName: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
    reason: v.optional(v.pipe(v.string(), v.maxLength(500))),
  }),
  v.object({
    action: v.literal('write_off'),
    branchId: v.pipe(v.string(), v.uuid()),
    variantId: v.pipe(v.string(), v.uuid()),
    qty: v.pipe(v.number(), v.integer(), v.minValue(1)),
    // ⚠️ Причина обязательна: списание без причины через месяц
    // неотличимо от кражи или ошибки ввода.
    reason: v.pipe(v.string(), v.minLength(3), v.maxLength(500)),
  }),
  v.object({
    action: v.literal('overdue_charge'),
    orderId: v.pipe(v.string(), v.uuid()),
  }),
])

export interface PostIncidentRequest {
  body: unknown
}

export async function postIncident(
  session: Session,
  req: PostIncidentRequest,
  deps: Deps,
) {

  const parsed = v.safeParse(IncidentBody, req.body)
  if (!parsed.success) throw apiError('VALIDATION_FAILED', 'Проверьте данные действия')
  const input = parsed.output

  try {
    return await deps.db.tx(session.tenantId, async (c) => {
      switch (input.action) {
        case 'no_show': {
          if (!can(session.activeRole, 'noshow.clear')) {
            throw apiError('FORBIDDEN', 'Недостаточно прав')
          }
          await markNoShow(c, {
            tenantId: session.tenantId,
            orderId: input.orderId,
            staffId: session.activeStaffId,
            reason: input.reason,
          })
          return { ok: true }
        }

        case 'transfer': {
          if (!can(session.activeRole, 'order.cancel')) {
            throw apiError('FORBIDDEN', 'Недостаточно прав')
          }
          return transferOrder(c, {
            tenantId: session.tenantId,
            orderId: input.orderId,
            newPhone: input.newPhone,
            newName: input.newName,
            staffId: session.activeStaffId,
            reason: input.reason,
          })
        }

        case 'write_off': {
          if (!canAccessBranch(session, input.branchId)) {
            throw apiError('FORBIDDEN', 'Этот филиал вам недоступен')
          }
          return writeOffVariant(c, {
            tenantId: session.tenantId,
            branchId: input.branchId,
            variantId: input.variantId,
            qty: input.qty,
            staffId: session.activeStaffId,
            reason: input.reason,
          })
        }

        case 'overdue_charge':
          return overdueCharge(c, {
            tenantId: session.tenantId,
            orderId: input.orderId,
          })
      }
    })
  } catch (err) {
    throw mapDbError(err)
  }
}
