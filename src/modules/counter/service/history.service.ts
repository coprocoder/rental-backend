/**
 * Краткая история клиента на экране выдачи.
 *
 * ⚠️ Вход по orderId, а не по телефону — намеренно. «Найти клиента по
 * телефону и посмотреть историю» превратило бы стойку в инструмент
 * выгрузки ПД, а 152-ФЗ не разрешает доступ без необходимости.
 * История показывается только в контексте текущего заказа.
 *
 * ⚠️ Не скидки и не приоритет: только скорость и точность. Условия
 * договора для всех одинаковы (публичный договор).
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import { apiError } from '~/kernel/errors'
import { historyForOrder } from '~/domain/orders/customer-history'
import { recommendDin } from '~/domain/fitting/din'

export async function getHistory(
  session: Session,
  input: Record<string, unknown>,
  deps: Deps,
) {
  const orderId = String(input.orderId ?? '')
  if (!orderId) throw apiError('VALIDATION_FAILED', 'Нужен orderId')

  const history = await deps.db.tx(session.tenantId, (c) => historyForOrder(c, {
    tenantId: session.tenantId,
    orderId,
    // Владелец и админ видят всю сеть, стойка и техник — свои филиалы.
    branchIds: session.activeRole === 'owner' || session.activeRole === 'admin'
      ? []
      : session.branchIds,
  }))

  // ⚠️ Рекомендация DIN отдаётся вместе с историей: техник открывает
  // один экран, а не два. Это НАРЯД — код и диапазон, точное значение
  // он выставляет по таблице своего крепления и подписывает.
  const din = history?.bodyParams
    ? recommendDin({
        weight: Number(history.bodyParams.weight ?? 0),
        height: Number(history.bodyParams.height ?? 0) || undefined,
      })
    : null

  return { history, din }
}
