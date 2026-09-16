/**
 * Сценарий «кто вошёл». Возвращает АКТИВНОГО сотрудника, не владельца
 * сессии — они различаются после переключения по PIN.
 *
 * ⚠️ Отдаёт ещё и тему тенанта, потому что она общая для ВСЕХ
 * интерфейсов проката — витрины, админки и стойки. Раньше тему знала
 * только витрина, и владелец, поменяв цвет, видел его на клиентской
 * форме, но не у себя: данные тенанта разделены, а оформление нет.
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import { pickTheme } from '~/common/utils/theme'
import { entitlementsFor, hasFeature } from '~/domain/core/entitlements'
import { PLAN_FEATURES, type PlanFeature } from '~/common/contract/plans'

export async function getMe(session: Session, deps: Deps) {
  const { theme, tenantName, features, planCode } = await deps.db.tx(
    session.tenantId,
    async (c) => {
      const { rows } = await c.query<{ theme: Record<string, unknown> | null, name: string }>(
        `SELECT theme, name FROM tenant WHERE id = $1`,
        [session.tenantId],
      )
      // ⚠️ Функции тарифа едут ВМЕСТЕ с сотрудником, а не отдельным
      // запросом: меню строится на каждой странице, и второй запрос
      // означал бы мигание пунктов после отрисовки.
      const e = await entitlementsFor(c, session.tenantId)
      const features = Object.fromEntries(
        PLAN_FEATURES.map((f) => [f, hasFeature(e, f)]),
      ) as Record<PlanFeature, boolean>

      return {
        // ⚠️ Через тот же белый список, что и витрина: тема — данные
        // тенанта, и отдавать их в интерфейс без pickTheme значит
        // пустить произвольный CSS в страницу персонала.
        theme: pickTheme(rows[0]?.theme),
        tenantName: rows[0]?.name ?? '',
        features,
        planCode: e.planCode,
      }
    },
  )

  return {
    name: session.activeName,
    role: session.activeRole,
    branchIds: session.branchIds,
    /** Отличается от активного после PIN-переключения. */
    sessionOwnerId: session.staffId,
    tenantName,
    theme,
    /** ⚠️ Только для ПОКАЗА: доступ закрывает сервер (requirePlanFeature). */
    features,
    planCode,
  }
}
