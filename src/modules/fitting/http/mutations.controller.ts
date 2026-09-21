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
import * as v from 'valibot'
import { documentRoute } from '~/transport/openapi/registry'
import { postFitRules, FitRulesBody } from '../service/fit-rules.mutation'

documentRoute({ method: 'post', path: '/v1/admin/fit-rules', scope: 'staff',
  body: FitRulesBody,
  /**
   * ⚠️ Публикация создаёт НОВУЮ редакцию таблицы подбора, а не правит
   * действующую: заказы ссылаются на версию, по которой подбирали.
   */
  response: v.object({ id: v.pipe(v.string(), v.uuid()), version: v.number() }),
  summary: 'Публикация таблицы подбора: рост/вес → размер, новой редакцией' })

export function registerFittingMutations(app: App, deps: Deps): void {
  app.post('/v1/admin/fit-rules', async (httpReq) => {
    const s = await requirePlanFeature(deps.db, httpReq.cookies[SESSION_COOKIE], 'inventory.manage', 'branding')
    return postFitRules(s, { body: httpReq.body }, deps)
  })
}
