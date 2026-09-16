/**
 * Маршруты админки модуля `tenant`.
 *
 * ⚠️ Право и тариф — ДВЕ РАЗНЫЕ проверки: «этому сотруднику можно?» и
 * «этот прокат оплатил?». Проверять по отдельности в каждом обработчике
 * — значит однажды забыть вторую и раздать платную функцию бесплатно.
 */
import type { App } from '~/transport/types'
import type { Deps } from '~/kernel/deps'
import { SESSION_COOKIE, requirePlanFeature, requireSession } from '~/kernel/session'
import { getTexts } from '../service/admin-texts.service'
import { getIntegrations } from '../service/admin-integrations.service'
import { getExport } from '../service/admin-export.service'
import { getReports } from '../service/admin-reports.service'
import { getLostDemand } from '../service/admin-lost-demand.service'
import { getSetup } from '../service/admin-setup.service'

export function registerTenantAdminRoutes(app: App, deps: Deps): void {
  app.get('/v1/admin/texts', async (req) => {
    const s = await requirePlanFeature(deps.db, req.cookies[SESSION_COOKIE], 'staff.manage', 'branding')
    return getTexts(s, req.query as Record<string, unknown>, deps)
  })
  app.get('/v1/admin/integrations', async (req) => {
    const s = await requirePlanFeature(deps.db, req.cookies[SESSION_COOKIE], 'integrations.manage', 'apiAccess')
    return getIntegrations(s, deps)
  })
  app.get('/v1/admin/lost-demand', async (req) => {
    const s = await requirePlanFeature(deps.db, req.cookies[SESSION_COOKIE], 'reports.revenue', 'analytics')
    const q = req.query as Record<string, unknown>
    return getLostDemand(s, {
      branchId: typeof q.branchId === 'string' ? q.branchId : undefined,
      from: typeof q.from === 'string' ? q.from : undefined,
      to: typeof q.to === 'string' ? q.to : undefined,
    }, deps)
  })

  app.get('/v1/admin/reports', async (req) => {
    const s = await requirePlanFeature(deps.db, req.cookies[SESSION_COOKIE], 'reports.revenue', 'analytics')
    return getReports(s, req.query as Record<string, unknown>, deps)
  })
  app.get('/v1/admin/setup', async (req) => {
    const s = await requireSession(req.cookies[SESSION_COOKIE])
    return getSetup(s, deps)
  })

  /**
   * ⚠️ Отдаёт CSV, а не JSON: заголовки ставит контроллер — сервис о
   * существовании HTTP не знает и возвращает просто строку.
   */
  app.get('/v1/admin/export', async (httpReq, reply) => {
    const s = await requirePlanFeature(deps.db, httpReq.cookies[SESSION_COOKIE], 'reports.revenue', 'analytics')
    const q = httpReq.query as Record<string, unknown>
    const kind = String(q.kind ?? 'orders')
    reply.header('content-type', 'text/csv; charset=utf-8')
    reply.header('content-disposition', `attachment; filename="${kind}.csv"`)
    return getExport(s, { query: q }, deps)
  })
}
