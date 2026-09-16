/**
 * Проверка сессии сотрудника на запросе.
 *
 * ⚠️ tenant_id берётся ТОЛЬКО из сессии, никогда из тела запроса или
 * query-параметра (../rental-docs/docs/04-тз/10-бэкенд/17-доступ-и-роли.md): подмена одного
 * поля дала бы доступ к чужим данным, и RLS этому не помешала бы —
 * она доверяет app.tenant_id, который выставляет приложение.
 *
 * ⚠️ Отличие от Nuxt-версии: вместо `H3Event` принимается сам токен.
 * Читает его транспорт — это единственное место, которое обязано знать,
 * что снаружи HTTP и что сессия ездит в cookie. Благодаря этому сценарии
 * вызываются из воркера и из теста без подделки объекта запроса.
 */
import type { PoolClient } from 'pg'
import { apiError } from './errors'
import { can, resolveSession, type Permission, type Session } from '~/domain/core/auth'
import { requireFeature } from '~/domain/core/entitlements'
import type { PlanFeature } from '~/common/contract/plans'
import type { Db } from './db'

export type { Session, Permission }

export async function requireSession(token: string | undefined): Promise<Session> {
  if (!token) throw apiError('FORBIDDEN', 'Нужен вход')

  const session = await resolveSession(token)
  if (!session) throw apiError('FORBIDDEN', 'Сессия истекла — войдите снова')

  return session
}

/** Требует полномочие у АКТИВНОГО сотрудника. */
export async function requirePermission(
  token: string | undefined,
  permission: Permission,
): Promise<Session> {
  const session = await requireSession(token)
  if (!can(session.activeRole, permission)) {
    throw apiError('FORBIDDEN', 'Недостаточно прав для этого действия')
  }
  return session
}

/**
 * Права сотрудника И функция тарифа сразу.
 *
 * ⚠️ Две РАЗНЫЕ границы, которые легко перепутать: право отвечает на
 * «этому сотруднику можно?», тариф — на «этот прокат это оплатил?».
 * Смешивать их в одну проверку нельзя, а проверять по отдельности в
 * каждом обработчике — значит однажды забыть вторую и раздать платную
 * функцию бесплатно.
 *
 * ⚠️ Сначала право, потом тариф: сотруднику без прав незачем знать,
 * какой тариф у проката.
 */
export async function requirePlanFeature(
  db: Db,
  token: string | undefined,
  permission: Permission,
  feature: PlanFeature,
): Promise<Session> {
  const session = await requirePermission(token, permission)
  await db.tx(session.tenantId, (c: PoolClient) =>
    requireFeature(c, session.tenantId, feature))
  return session
}
