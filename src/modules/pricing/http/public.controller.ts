/**
 * Публичные маршруты модуля `pricing`.
 *
 * ⚠️ Клиент здесь АНОНИМЕН: сессии нет, тенант определяется слагом
 * витрины или токеном заказа. Токен — не идентификатор: по нему
 * действует неаутентифицированный клиент и видит один свой заказ.
 */
import type { App } from '~/transport/types'
import type { Deps } from '~/kernel/deps'
import { postQuote } from '../service/quote.public'

export function registerPricingPublic(app: App, deps: Deps): void {
  app.post('/v1/public/quote', async (httpReq) => {
    return postQuote({ body: httpReq.body }, deps)
  })
}
