/**
 * Заказ для стойки: позиции, которые надо выдать или принять.
 *
 * ⚠️ Тот же orderDetail, что и в админке, а не своя выборка: расхождение
 * между тем, что видит стойка, и тем, что видит админка, — это спор
 * между сотрудниками о том, что было в заказе. Одна функция такого
 * спора не допускает.
 *
 * ⚠️ Право не проверяется отдельно: посмотреть заказ своего филиала
 * может любой сотрудник — техник тоже должен видеть, что́ он готовит.
 * Ограничивают выдачу и возврат, а не просмотр.
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import { apiError } from '~/kernel/errors'
import { orderDetail } from '~/domain/admin/admin'
import { canAccessBranch } from '~/domain/core/auth'

export interface GetCounterOrderInput {
  params: Record<string, string>
}

export async function getCounterOrder(
  session: Session,
  req: GetCounterOrderInput,
  deps: Deps,
) {
  const orderId = req.params.id
  if (!orderId) throw apiError('VALIDATION_FAILED', 'Нужен id заказа')

  const order = await deps.db.tx(session.tenantId, (c) =>
    orderDetail(c, { tenantId: session.tenantId, orderId }))

  if (!order) throw apiError('NOT_FOUND', 'Заказ не найден')
  if (!canAccessBranch(session, order.branchId)) {
    throw apiError('FORBIDDEN', 'Заказ другого филиала')
  }

  return order
}
