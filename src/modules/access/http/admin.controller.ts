/**
 * Маршруты админки модуля `access`.
 *
 * ⚠️ Право и тариф — ДВЕ РАЗНЫЕ проверки: «этому сотруднику можно?» и
 * «этот прокат оплатил?». Проверять по отдельности в каждом обработчике
 * — значит однажды забыть вторую и раздать платную функцию бесплатно.
 */
import type { App } from '~/transport/types'
import type { Deps } from '~/kernel/deps'
import * as v from 'valibot'
import { documentRoute } from '~/transport/openapi/registry'
import { SESSION_COOKIE, requirePermission } from '~/kernel/session'
import { getFlags } from '../service/admin-flags.service'

const FlagsResponse = v.object({
  flags: v.array(v.object({
    flag: v.string(),
    title: v.string(),
    enabled: v.boolean(),
    /** Значение задано вручную, а не взято из тарифа. */
    overridden: v.boolean(),
    reason: v.nullable(v.string()),
    until: v.nullable(v.string()),
    /** Прокат может переключить сам, без поддержки. */
    selfService: v.boolean(),
  })),
})

documentRoute({ method: 'get', path: '/v1/admin/flags', scope: 'staff', response: FlagsResponse,
  summary: 'Переключатели функций: что включено и кем' })

export function registerAccessAdminRoutes(app: App, deps: Deps): void {
  app.get('/v1/admin/flags', async (req) => {
    const s = await requirePermission(req.cookies[SESSION_COOKIE], 'plan.manage')
    return getFlags(s, deps)
  })
}
