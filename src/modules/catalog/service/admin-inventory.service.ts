/**
 * Список инвентаря с остатками и будущими бронями (13.4).
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import { inventoryList } from '~/domain/admin/admin'

export async function getInventory(
  session: Session,
  input: Record<string, unknown>,
  deps: Deps,
) {
  const q = input

  return deps.db.tx(session.tenantId, async (c) => ({
    items: await inventoryList(c, {
      tenantId: session.tenantId,
      branchIds: session.activeRole === 'owner' || session.activeRole === 'admin'
        ? []
        : session.branchIds,
      q: typeof q.q === 'string' ? q.q : undefined,
      locale: typeof q.locale === 'string' ? q.locale : undefined,
    }),
  }))
}
