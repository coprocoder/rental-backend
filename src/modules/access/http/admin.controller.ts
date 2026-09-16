/**
 * Маршруты админки модуля `access`.
 *
 * ⚠️ Право и тариф — ДВЕ РАЗНЫЕ проверки: «этому сотруднику можно?» и
 * «этот прокат оплатил?». Проверять по отдельности в каждом обработчике
 * — значит однажды забыть вторую и раздать платную функцию бесплатно.
 */
import type { App } from '~/transport/types'
import type { Deps } from '~/kernel/deps'
import { SESSION_COOKIE, requirePermission } from '~/kernel/session'
import { getFlags } from '../service/admin-flags.service'

export function registerAccessAdminRoutes(app: App, deps: Deps): void {
  app.get('/v1/admin/flags', async (req) => {
    const s = await requirePermission(req.cookies[SESSION_COOKIE], 'plan.manage')
    return getFlags(s, deps)
  })
}
