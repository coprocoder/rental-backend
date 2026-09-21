/**
 * Текущая смена филиала со сводкой.
 *
 * ⚠️ Смена ищется по ФИЛИАЛУ, а не по сотруднику: смена принадлежит
 * точке, а не человеку. Утренний уходит, вечерний приходит — смена та
 * же, и незакрытые выдачи переходят к нему. Привязка к сотруднику
 * означала бы, что при пересменке половина операций теряет контекст.
 *
 * ⚠️ Неявная смена (заведённая автоматически при первой операции) тоже
 * отдаётся, и помечена флагом: сотрудник должен видеть, что смену
 * никто не открывал руками, — иначе касса за день окажется без
 * начального остатка и сойтись не сможет.
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import { apiError } from '~/kernel/errors'
import { canAccessBranch } from '~/domain/core/auth'
import { daySummary, shiftSummary } from '~/domain/counter/shift'

export async function getShift(
  session: Session,
  input: Record<string, unknown>,
  deps: Deps,
) {
  const q = input

  const branchId = typeof q.branchId === 'string' && q.branchId
    ? q.branchId
    : session.branchIds[0]

  if (!branchId) {
    // Владелец без привязки к филиалу должен выбрать точку сам:
    // «смена» без филиала не существует.
    return { branchId: null, shift: null }
  }
  if (!canAccessBranch(session, branchId)) {
    throw apiError('FORBIDDEN', 'Этот филиал вам недоступен')
  }

  return deps.db.tx(session.tenantId, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `SELECT id FROM shift
       WHERE tenant_id = $1 AND branch_id = $2 AND closed_at IS NULL
       ORDER BY opened_at DESC LIMIT 1`,
      [session.tenantId, branchId],
    )
    const open = rows[0]
    return {
      branchId,
      shift: open ? await shiftSummary(c, open.id) : null,
      // Сводка дня с кассой (17.15): отдаётся вместе со сменой, чтобы
      // передача смены была одним экраном, а не двумя запросами.
      day: open ? await daySummary(c, open.id) : null,
    }
  })
}
