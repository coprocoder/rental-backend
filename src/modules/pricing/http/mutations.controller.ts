/**
 * Мутации модуля `pricing`.
 *
 * ⚠️ Право и тариф — ДВЕ РАЗНЫЕ проверки, и для мутаций цена ошибки
 * выше, чем для чтения: забытая проверка тарифа раздаёт платную
 * функцию, забытое право — доступ к чужим действиям.
 */
import type { App } from '~/transport/types'
import type { Deps } from '~/kernel/deps'
import { SESSION_COOKIE, requirePermission } from '~/kernel/session'
import * as v from 'valibot'
import { documentRoute } from '~/transport/openapi/registry'
import { postPriceRules, PriceRulesBody } from '../service/price-rules.mutation'

documentRoute({ method: 'post', path: '/v1/admin/price-rules', scope: 'staff',
  body: PriceRulesBody,
  response: v.object({ id: v.pipe(v.string(), v.uuid()) }),
  summary: 'Правила цены: тариф позиции на период, с проверкой пересечений' })

export function registerPricingMutations(app: App, deps: Deps): void {
  app.post('/v1/admin/price-rules', async (httpReq) => {
    const s = await requirePermission(httpReq.cookies[SESSION_COOKIE], 'price.manage')
    return postPriceRules(s, { body: httpReq.body }, deps)
  })
}
