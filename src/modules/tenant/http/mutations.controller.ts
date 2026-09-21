/**
 * Мутации модуля `tenant`.
 *
 * ⚠️ Право и тариф — ДВЕ РАЗНЫЕ проверки, и для мутаций цена ошибки
 * выше, чем для чтения: забытая проверка тарифа раздаёт платную
 * функцию, забытое право — доступ к чужим действиям.
 */
import type { App } from '~/transport/types'
import type { Deps } from '~/kernel/deps'
import { SESSION_COOKIE, requirePermission, requirePlanFeature } from '~/kernel/session'
import { postBranches } from '../service/branches.mutation'
import { postSchedule } from '../service/schedule.mutation'
import { postTexts } from '../service/texts.mutation'
import { postTheme } from '../service/theme.mutation'
import { postIntegrations } from '../service/integrations.mutation'
import { postPlan } from '../service/plan.mutation'
import { postPrivacy } from '../service/privacy.mutation'
import { postStaff } from '../service/staff.mutation'

export function registerTenantMutations(app: App, deps: Deps): void {
  app.post('/v1/admin/branches', async (httpReq) => {
    const s = await requirePlanFeature(deps.db, httpReq.cookies[SESSION_COOKIE], 'inventory.manage', 'multiBranch')
    return postBranches(s, { body: httpReq.body }, deps)
  })
  app.post('/v1/admin/schedule', async (httpReq) => {
    const s = await requirePlanFeature(deps.db, httpReq.cookies[SESSION_COOKIE], 'inventory.manage', 'advancedInventory')
    return postSchedule(s, { body: httpReq.body }, deps)
  })
  app.post('/v1/admin/texts', async (httpReq) => {
    const s = await requirePlanFeature(deps.db, httpReq.cookies[SESSION_COOKIE], 'staff.manage', 'branding')
    return postTexts(s, { body: httpReq.body }, deps)
  })
  app.post('/v1/admin/theme', async (httpReq) => {
    const s = await requirePlanFeature(deps.db, httpReq.cookies[SESSION_COOKIE], 'staff.manage', 'branding')
    return postTheme(s, { body: httpReq.body }, deps)
  })
  app.post('/v1/admin/integrations', async (httpReq) => {
    const s = await requirePermission(httpReq.cookies[SESSION_COOKIE], 'integrations.manage')
    return postIntegrations(s, { body: httpReq.body }, deps)
  })
  app.post('/v1/admin/plan', async (httpReq) => {
    const s = await requirePermission(httpReq.cookies[SESSION_COOKIE], 'plan.manage')
    return postPlan(s, { body: httpReq.body }, deps)
  })
  app.post('/v1/admin/privacy', async (httpReq) => {
    const s = await requirePermission(httpReq.cookies[SESSION_COOKIE], 'staff.manage')
    return postPrivacy(s, { body: httpReq.body }, deps)
  })
  app.post('/v1/admin/staff', async (httpReq) => {
    const s = await requirePermission(httpReq.cookies[SESSION_COOKIE], 'staff.manage')
    return postStaff(s, { body: httpReq.body }, deps)
  })
}
