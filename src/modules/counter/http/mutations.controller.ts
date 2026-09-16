/**
 * Мутации модуля `counter`.
 *
 * ⚠️ Право и тариф — ДВЕ РАЗНЫЕ проверки, и для мутаций цена ошибки
 * выше, чем для чтения: забытая проверка тарифа раздаёт платную
 * функцию, забытое право — доступ к чужим действиям.
 */
import type { App } from '~/transport/types'
import type { Deps } from '~/kernel/deps'
import { SESSION_COOKIE, requirePermission, requireSession } from '~/kernel/session'
import { postDin } from '../service/din.mutation'
import { postIncident } from '../service/incident.mutation'
import { postIssue } from '../service/issue.mutation'
import { postReturn } from '../service/return.mutation'
import { postShift } from '../service/shift.mutation'
import { postStocktake } from '../service/stocktake.mutation'
import { postUpsell } from '../service/upsell.mutation'
import { postWalkIn } from '../service/walk-in.mutation'

export function registerCounterMutations(app: App, deps: Deps): void {
  app.post('/v1/counter/din', async (httpReq) => {
    const s = await requirePermission(httpReq.cookies[SESSION_COOKIE], 'din.record')
    return postDin(s, { body: httpReq.body }, deps)
  })
  app.post('/v1/counter/incident', async (httpReq) => {
    const s = await requireSession(httpReq.cookies[SESSION_COOKIE])
    return postIncident(s, { body: httpReq.body }, deps)
  })
  app.post('/v1/counter/issue', async (httpReq) => {
    const s = await requireSession(httpReq.cookies[SESSION_COOKIE])
    return postIssue(s, { body: httpReq.body }, deps)
  })
  app.post('/v1/counter/return', async (httpReq) => {
    const s = await requireSession(httpReq.cookies[SESSION_COOKIE])
    return postReturn(s, { body: httpReq.body }, deps)
  })
  app.post('/v1/counter/shift', async (httpReq) => {
    const s = await requireSession(httpReq.cookies[SESSION_COOKIE])
    return postShift(s, { body: httpReq.body }, deps)
  })
  app.post('/v1/counter/stocktake', async (httpReq) => {
    const s = await requirePermission(httpReq.cookies[SESSION_COOKIE], 'inventory.manage')
    return postStocktake(s, { body: httpReq.body }, deps)
  })
  app.post('/v1/counter/upsell', async (httpReq) => {
    const s = await requireSession(httpReq.cookies[SESSION_COOKIE])
    return postUpsell(s, { body: httpReq.body }, deps)
  })
  app.post('/v1/counter/walk-in', async (httpReq) => {
    const s = await requireSession(httpReq.cookies[SESSION_COOKIE])
    return postWalkIn(s, { body: httpReq.body }, deps)
  })
}
