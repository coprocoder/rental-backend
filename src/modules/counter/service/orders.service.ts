/**
 * Список заказов для стойки.
 *
 * ⚠️ Заказы на сегодня открыты по умолчанию: оттуда приходит
 * большинство клиентов (../rental-docs/docs/04-тз/20-фронтенд/24-стойка.md). Поиск —
 * три равноправных способа, ни один не обязателен.
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import { apiError } from '~/kernel/errors'
import { canAccessBranch } from '~/domain/core/auth'
import { findOrders } from '~/domain/counter/counter'

export async function getOrders(
  session: Session,
  input: Record<string, unknown>,
  deps: Deps,
) {
  const query = input

  const branchId = typeof query.branchId === 'string' ? query.branchId : undefined

  // ⚠️ Вторая граница поверх RLS: сотрудник стойки видит только свои
  // филиалы, иначе ему доступны ПД клиентов всей сети.
  if (branchId && !canAccessBranch(session, branchId)) {
    throw apiError('FORBIDDEN', 'Этот филиал вам недоступен')
  }

  // Без указания филиала стойка видит только свои — не всё подряд.
  const effectiveBranch = branchId
    ?? (session.activeRole === 'counter' || session.activeRole === 'technician'
      ? session.branchIds[0]
      : undefined)

  return deps.db.tx(session.tenantId, async (c) => ({
    orders: await findOrders(c, {
      tenantId: session.tenantId,
      q: typeof query.q === 'string' ? query.q : undefined,
      branchId: effectiveBranch,
      today: query.today !== 'false',
    }),
  }))
}
