/**
 * Маршруты настроек проката.
 *
 * ⚠️ Право и тариф — ДВЕ РАЗНЫЕ проверки: «этому сотруднику можно?» и
 * «этот прокат оплатил?». Смешивать нельзя, а проверять по отдельности
 * в каждом обработчике — значит однажды забыть вторую и раздать платную
 * функцию бесплатно.
 */
import type { App } from '~/transport/types'
import type { Deps } from '~/kernel/deps'
import { SESSION_COOKIE, requirePermission, requirePlanFeature } from '~/kernel/session'
import { getBranches, getPlan, getStaff, getTheme, getToday } from '../service/tenant.service'

export function registerTenantRoutes(app: App, deps: Deps): void {
  app.get('/v1/admin/theme', async (req) => {
    const s = await requirePlanFeature(deps.db, req.cookies[SESSION_COOKIE], 'staff.manage', 'branding')
    return getTheme(s, deps)
  })

  app.get('/v1/admin/staff', async (req) => {
    const s = await requirePlanFeature(deps.db, req.cookies[SESSION_COOKIE], 'staff.manage', 'advancedInventory')
    return getStaff(s, deps)
  })

  app.get('/v1/admin/branches', async (req) => {
    const s = await requirePlanFeature(deps.db, req.cookies[SESSION_COOKIE], 'inventory.manage', 'multiBranch')
    return getBranches(s, deps)
  })

  /**
   * ⚠️ Сводка дня — часть аналитики: она про выручку и состояние
   * проката целиком. Без этой проверки экран оставался открытым по
   * прямой ссылке, хотя пункт меню уже был скрыт тарифом — ровно тот
   * разрыв, из-за которого «скрыто» принимают за «закрыто».
   */
  app.get('/v1/admin/today', async (req) => {
    const s = await requirePlanFeature(deps.db, req.cookies[SESSION_COOKIE], 'reports.revenue', 'analytics')
    return getToday(s, deps)
  })

  app.get('/v1/admin/plan', async (req) => {
    const s = await requirePermission(req.cookies[SESSION_COOKIE], 'plan.manage')
    return getPlan(s, deps)
  })
}
