/**
 * Мутации модуля `booking`.
 *
 * ⚠️ Право и тариф — ДВЕ РАЗНЫЕ проверки, и для мутаций цена ошибки
 * выше, чем для чтения: забытая проверка тарифа раздаёт платную
 * функцию, забытое право — доступ к чужим действиям.
 */
import type { App } from '~/transport/types'
import type { Deps } from '~/kernel/deps'
import { SESSION_COOKIE, requireSession } from '~/kernel/session'
import { postOrderAction } from '../service/action.mutation'

export function registerBookingMutations(app: App, deps: Deps): void {
  app.post<{ Params: { id: string } }>('/v1/admin/orders/:id/action', async (httpReq) => {
    const s = await requireSession(httpReq.cookies[SESSION_COOKIE])
    return postOrderAction(s, { body: httpReq.body, params: httpReq.params as Record<string, string> }, deps)
  })
}
