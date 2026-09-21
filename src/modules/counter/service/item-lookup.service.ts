/**
 * Найти вещь по номеру — приёмка по скану.
 *
 * ⚠️ Вещь САМА говорит, в каком она заказе: искать заказ по телефону
 * или фамилии не нужно. Это главное, ради чего метка вообще нужна на
 * стойке (25-учёт-без-оборудования).
 *
 * ⚠️ «Не нашли» — нормальный ответ на чужую или стёртую метку, а не
 * ошибка: экран покажет подсказку, а сотрудник продолжит работать
 * обычным поиском.
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import { lookupItemForReturn } from '~/domain/counter/counter'

export async function getItemLookup(
  session: Session,
  input: Record<string, unknown>,
  deps: Deps,
) {
  const code = String(input.code ?? '').trim()
  if (!code) return { item: null }

  return deps.db.tx(session.tenantId, async (c) => ({
    item: await lookupItemForReturn(c, { tenantId: session.tenantId, code }),
  }))
}
