/**
 * Мутации модуля `fitting`.
 *
 * ⚠️ Право и тариф — ДВЕ РАЗНЫЕ проверки, и для мутаций цена ошибки
 * выше, чем для чтения: забытая проверка тарифа раздаёт платную
 * функцию, забытое право — доступ к чужим действиям.
 */
import type { App } from '~/transport/types'
import type { Deps } from '~/kernel/deps'
import { SESSION_COOKIE, requirePlanFeature } from '~/kernel/session'
import { postFitRules } from '../service/fit-rules.mutation'

export function registerFittingMutations(app: App, deps: Deps): void {
  app.post('/v1/admin/fit-rules', async (httpReq) => {
    const s = await requirePlanFeature(deps.db, httpReq.cookies[SESSION_COOKIE], 'inventory.manage', 'branding')
    return postFitRules(s, { body: httpReq.body }, deps)
  })
}
