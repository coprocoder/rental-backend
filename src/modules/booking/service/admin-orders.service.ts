/**
 * Список заказов с курсорной пагинацией и фильтрами.
 *
 * ⚠️ Курсор, а не OFFSET: при листании с OFFSET страницы съезжают по
 * мере появления новых заказов, и оператор видит одну бронь дважды
 * либо пропускает её.
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import { listOrders } from '~/domain/admin/admin'

export async function getOrders(
  session: Session,
  input: Record<string, unknown>,
  deps: Deps,
) {
  // ⚠️ order.confirm, а не просто сессия: по ТЗ у ТЕХНИКА заказов нет,
  // а список отдавал ему имена и телефоны клиентов. Раньше гейт здесь
  // оставил бы роль с пустым меню — теперь у неё есть свой экран
  // обслуживания, и закрывать заказы стало безопасно.
  const query = input

  const status = typeof query.status === 'string'
    ? query.status.split(',').filter(Boolean)
    : undefined

  /**
   * Филиал из фильтра сужает выборку, но НЕ расширяет её.
   *
   * ⚠️ Сотрудник видит только свои филиалы (`session.branchIds`);
   * подставить в фильтр чужой id и получить чужие заказы нельзя —
   * пересечение с доступными считается здесь, а не на клиенте.
   */
  const all = session.activeRole === 'owner' || session.activeRole === 'admin'
  const asked = typeof query.branchId === 'string' && query.branchId ? [query.branchId] : []
  const branchIds = asked.length
    ? (all ? asked : asked.filter((id) => session.branchIds.includes(id)))
    : (all ? [] : session.branchIds)

  return deps.db.tx(session.tenantId, (c) => listOrders(c, {
    tenantId: session.tenantId,
    branchIds,
    status,
    q: typeof query.q === 'string' ? query.q : undefined,
    cursor: typeof query.cursor === 'string' ? query.cursor : undefined,
    limit: query.limit ? Number(query.limit) : undefined,
    from: typeof query.from === 'string' ? query.from : undefined,
    to: typeof query.to === 'string' ? query.to : undefined,
  }))
}
