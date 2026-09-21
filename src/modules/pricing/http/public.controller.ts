/**
 * Публичные маршруты модуля `pricing`.
 *
 * ⚠️ Клиент здесь АНОНИМЕН: сессии нет, тенант определяется слагом
 * витрины или токеном заказа. Токен — не идентификатор: по нему
 * действует неаутентифицированный клиент и видит один свой заказ.
 */
import * as v from 'valibot'
import type { App } from '~/transport/types'
import { documentRoute } from '~/transport/openapi/registry'
import type { Deps } from '~/kernel/deps'
import { postQuote, QuoteBody } from '../service/quote.public'

/**
 * Ответ расчёта: цена, наличие и подсказки по подбору.
 *
 * ⚠️ Деньги — СТРОКИ. Хранятся как `numeric`; превращение в `number`
 * теряет копейки на больших суммах, а это счёт, который видит клиент.
 *
 * ⚠️ Наличие и цена приходят ВМЕСТЕ и считаются сервером: клиент их
 * только показывает (железное правило 1). Поэтому в схеме они рядом —
 * это один ответ на один вопрос «можно ли и почём».
 */
const QuoteResponse = v.object({
  total: v.string(),
  days: v.number(),
  breakdown: v.array(v.object({
    variantId: v.pipe(v.string(), v.uuid()),
    variantName: v.string(),
    qty: v.number(),
    days: v.number(),
    unitTotal: v.string(),
    lineTotal: v.string(),
    /** Из каких правил сложилась цена — показывается клиенту. */
    appliedRules: v.array(v.object({
      kind: v.string(),
      label: v.string(),
      effect: v.string(),
    })),
  })),
  availability: v.array(v.object({
    variantId: v.pipe(v.string(), v.uuid()),
    available: v.boolean(),
    freeUnits: v.number(),
    /** Дни, в которые не хватает: клиент видит, что именно двигать. */
    shortageDays: v.array(v.string()),
    /** Свободное в соседних филиалах. */
    nearby: v.array(v.object({
      branchId: v.pipe(v.string(), v.uuid()),
      branchName: v.string(),
      freeUnits: v.number(),
    })),
  })),
  /** Подбор по параметрам тела: рост, вес, размер ноги. */
  suggestions: v.array(v.object({
    variantCode: v.string(),
    why: v.string(),
    confidence: v.string(),
  })),
  businessHours: v.object({
    ok: v.boolean(),
    problems: v.array(v.string()),
  }),
})

documentRoute({
  method: 'post',
  path: '/v1/public/quote',
  summary: 'Расчёт цены и наличия на выбранные даты',
  scope: 'public',
  body: QuoteBody,
  response: QuoteResponse,
})

export function registerPricingPublic(app: App, deps: Deps): void {
  app.post('/v1/public/quote', async (httpReq) => {
    return postQuote({ body: httpReq.body }, deps)
  })
}
