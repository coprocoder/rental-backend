/**
 * Ручные действия над заказом из карточки (13.3).
 *
 * ⚠️ У каждой автоматики есть ручной эквивалент, и обратный тоже
 * (железное правило №13). Подтверждение вместо клиента, отмена, отметка
 * неявки и её снятие — это те самые ручные эквиваленты: автомат
 * ошибается, а клиент стоит у стойки и ждать разбирательства не будет.
 *
 * ⚠️ ПРИЧИНА ОБЯЗАТЕЛЬНА для каждого действия и пишется в audit_log.
 * Без неё через месяц невозможно понять, почему у заказа нестандартные
 * условия, и ручное действие становится неотличимо от злоупотребления.
 * Поэтому причина проверяется здесь, а не «желательна в интерфейсе».
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import * as v from 'valibot'
import { apiError, mapDbError } from '~/kernel/errors'
import { audit, transition } from '~/domain/core/order-lifecycle'
import { markNoShow } from '~/domain/core/exceptions'
import { orderDetail } from '~/domain/admin/admin'
import { canAccessBranch, can } from '~/domain/core/auth'

export const OrderActionBody = v.object({
  action: v.picklist(['confirm', 'cancel', 'no_show', 'clear_no_show']),
  // ⚠️ Минимум 3 символа: «.» в поле причины — это формально
  // заполненная форма и пустой след в журнале.
  reason: v.pipe(v.string(), v.minLength(3, 'Опишите причину'), v.maxLength(500)),
})

/** Какое право требуется под каждое действие. */
const NEEDS = {
  confirm: 'order.confirm',
  cancel: 'order.cancel',
  no_show: 'order.cancel',
  clear_no_show: 'noshow.clear',
} as const

export interface PostOrderActionRequest {
  body: unknown
  params: Record<string, string>
}

export async function postOrderAction(
  session: Session,
  req: PostOrderActionRequest,
  deps: Deps,
) {
  const orderId = req.params.id
  if (!orderId) throw apiError('VALIDATION_FAILED', 'Нужен id заказа')

  const parsed = v.safeParse(OrderActionBody, req.body)
  if (!parsed.success) {
    throw apiError('VALIDATION_FAILED', parsed.issues[0]?.message ?? 'Укажите действие и причину')
  }
  const { action, reason } = parsed.output

  if (!can(session.activeRole, NEEDS[action])) {
    throw apiError('FORBIDDEN', 'Недостаточно прав для этого действия')
  }

  try {
    return await deps.db.tx(session.tenantId, async (c) => {
      const order = await orderDetail(c, { tenantId: session.tenantId, orderId })
      if (!order) throw apiError('NOT_FOUND', 'Заказ не найден')
      if (!canAccessBranch(session, order.branchId)) {
        throw apiError('FORBIDDEN', 'Заказ другого филиала')
      }

      const actor = { type: 'staff' as const, staffId: session.staffId, reason }

      if (action === 'confirm') {
        await transition(c, {
          orderId,
          to: 'confirmed',
          actor,
          correlationId: undefined,
        })
      } else if (action === 'cancel') {
        await transition(c, {
          orderId,
          to: 'cancelled',
          actor,
          correlationId: undefined,
        })
      } else if (action === 'no_show') {
        await markNoShow(c, {
          tenantId: session.tenantId,
          orderId,
          staffId: session.staffId,
          reason,
        })
      } else {
        // Снятие неявки: счётчик уменьшается, но не ниже нуля —
        // иначе повторное нажатие уводит клиента «в минус» и портит
        // и статистику, и будущие решения по нему.
        if (!order.customer.id) throw apiError('INVALID_STATE', 'У заказа нет клиента')
        await c.query(
          `UPDATE customer SET no_show_count = greatest(no_show_count - 1, 0)
           WHERE id = $1`,
          [order.customer.id],
        )
        await audit(c, {
          tenantId: session.tenantId,
          staffId: session.staffId,
          action: 'noshow.cleared',
          targetType: 'customer',
          targetId: order.customer.id,
          reason,
          before: { noShowCount: order.customer.noShowCount },
        })
      }

      return await orderDetail(c, { tenantId: session.tenantId, orderId })
    })
  } catch (err) {
    throw mapDbError(err)
  }
}
