/**
 * Карточка заказа и его лента событий для админки.
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import { apiError } from '~/kernel/errors'
import { orderDetail, orderTimeline } from '~/domain/admin/admin'
import { canAccessBranch } from '~/domain/core/auth'

export async function getOrderDetail(session: Session, orderId: string, deps: Deps) {
  const order = await deps.db.tx(session.tenantId, (c) =>
    orderDetail(c, { tenantId: session.tenantId, orderId }))
  if (!order) throw apiError('NOT_FOUND', 'Заказ не найден')

  // ⚠️ Вторая граница внутри тенанта: RLS изолирует прокаты друг от
  // друга, но сотрудник одной точки не должен видеть персональные данные
  // клиентов всей сети — это и беспорядок, и доступ к ПД без
  // необходимости (152-ФЗ).
  if (!canAccessBranch(session, order.branchId)) {
    throw apiError('FORBIDDEN', 'Заказ другого филиала')
  }
  return order
}

export async function getOrderTimeline(session: Session, orderId: string, deps: Deps) {
  return deps.db.tx(session.tenantId, async (c) => ({
    timeline: await orderTimeline(c, { tenantId: session.tenantId, orderId }),
  }))
}
