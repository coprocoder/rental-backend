/**
 * Маршруты админки модуля `pricing`.
 *
 * ⚠️ Право и тариф — ДВЕ РАЗНЫЕ проверки: «этому сотруднику можно?» и
 * «этот прокат оплатил?». Проверять по отдельности в каждом обработчике
 * — значит однажды забыть вторую и раздать платную функцию бесплатно.
 */
import type { App } from '~/transport/types'
import type { Deps } from '~/kernel/deps'
import { SESSION_COOKIE, requirePermission } from '~/kernel/session'
import { getPricing } from '../service/admin-pricing.service'

export function registerPricingAdminRoutes(app: App, deps: Deps): void {
  app.get('/v1/admin/pricing', async (req) => {
    const s = await requirePermission(req.cookies[SESSION_COOKIE], 'price.manage')
    return getPricing(s, req.query as Record<string, unknown>, deps)
  })
}
