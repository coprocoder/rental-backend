/**
 * Маршруты админки модуля `fitting`.
 *
 * ⚠️ Право и тариф — ДВЕ РАЗНЫЕ проверки: «этому сотруднику можно?» и
 * «этот прокат оплатил?». Проверять по отдельности в каждом обработчике
 * — значит однажды забыть вторую и раздать платную функцию бесплатно.
 */
import type { App } from '~/transport/types'
import type { Deps } from '~/kernel/deps'
import * as v from 'valibot'
import { documentRoute } from '~/transport/openapi/registry'
import { SESSION_COOKIE, requirePlanFeature } from '~/kernel/session'
import { getFitRules } from '../service/admin-fit-rules.service'

const FitRulesResponse = v.object({
  tables: v.array(v.object({
    id: v.pipe(v.string(), v.uuid()),
    categoryId: v.pipe(v.string(), v.uuid()),
    categoryCode: v.string(),
    categoryName: v.string(),
    /** Год чартов: таблицы подбора обновляются производителями. */
    chartYear: v.number(),
    version: v.number(),
    isActive: v.boolean(),
    rows: v.array(v.object({
      param: v.string(),
      min: v.number(),
      max: v.number(),
      value: v.string(),
    })),
  })),
  categories: v.array(v.object({
    id: v.pipe(v.string(), v.uuid()),
    code: v.string(),
    name: v.string(),
  })),
})

documentRoute({ method: 'get', path: '/v1/admin/fit-rules', scope: 'staff', response: FitRulesResponse,
  summary: 'Таблицы подбора размеров по параметрам тела' })

export function registerFittingAdminRoutes(app: App, deps: Deps): void {
  app.get('/v1/admin/fit-rules', async (req) => {
    const s = await requirePlanFeature(deps.db, req.cookies[SESSION_COOKIE], 'inventory.manage', 'branding')
    return getFitRules(s, req.query as Record<string, unknown>, deps)
  })
}
