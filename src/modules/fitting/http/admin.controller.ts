/**
 * Маршруты админки модуля `fitting`.
 *
 * ⚠️ Право и тариф — ДВЕ РАЗНЫЕ проверки: «этому сотруднику можно?» и
 * «этот прокат оплатил?». Проверять по отдельности в каждом обработчике
 * — значит однажды забыть вторую и раздать платную функцию бесплатно.
 */
import type { App } from '~/transport/types'
import type { Deps } from '~/kernel/deps'
import { SESSION_COOKIE, requirePlanFeature } from '~/kernel/session'
import { getFitRules } from '../service/admin-fit-rules.service'

export function registerFittingAdminRoutes(app: App, deps: Deps): void {
  app.get('/v1/admin/fit-rules', async (req) => {
    const s = await requirePlanFeature(deps.db, req.cookies[SESSION_COOKIE], 'inventory.manage', 'branding')
    return getFitRules(s, req.query as Record<string, unknown>, deps)
  })
}
