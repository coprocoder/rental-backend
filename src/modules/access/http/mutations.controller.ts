/**
 * Мутации модуля `access`.
 *
 * ⚠️ Право и тариф — ДВЕ РАЗНЫЕ проверки, и для мутаций цена ошибки
 * выше, чем для чтения: забытая проверка тарифа раздаёт платную
 * функцию, забытое право — доступ к чужим действиям.
 */
import type { App } from '~/transport/types'
import type { Deps } from '~/kernel/deps'
import { SESSION_COOKIE, requirePermission } from '~/kernel/session'
import { postFlags } from '../service/flags.mutation'

export function registerAccessMutations(app: App, deps: Deps): void {
  app.post('/v1/admin/flags', async (httpReq) => {
    const s = await requirePermission(httpReq.cookies[SESSION_COOKIE], 'plan.manage')
    return postFlags(s, { body: httpReq.body }, deps)
  })
}
