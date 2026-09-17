/**
 * Маршруты админки модуля `pricing`.
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
import { getPricing } from '../service/admin-pricing.service'

const PricingResponse = v.object({
  rules: v.array(v.object({
    id: v.pipe(v.string(), v.uuid()),
    variantId: v.pipe(v.string(), v.uuid()),
    /** `base` — ставка, `modifier` — скидка или наценка. */
    ruleKind: v.string(),
    // ⚠️ Деньги строкой: numeric в БД, number терял бы копейки.
    amount: v.nullable(v.string()),
    /** Цены по дням аренды: «первый день дороже». */
    dayRates: v.nullable(v.record(v.string(), v.unknown())),
    percent: v.nullable(v.number()),
    priority: v.number(),
    stackable: v.boolean(),
    isActive: v.boolean(),
    validFrom: v.string(),
    validTo: v.nullable(v.string()),
    conditions: v.record(v.string(), v.unknown()),
    variantCode: v.string(),
    variantName: v.string(),
    categoryName: v.string(),
  })),
  categories: v.array(v.object({
    id: v.pipe(v.string(), v.uuid()),
    code: v.string(),
    name: v.string(),
    /** У услуг нет склада: «заточка» не ограничена наличием. */
    isService: v.boolean(),
  })),
  branches: v.array(v.object({
    id: v.pipe(v.string(), v.uuid()),
    name: v.string(),
  })),
})

documentRoute({ method: 'get', path: '/v1/admin/pricing', scope: 'staff', response: PricingResponse,
  summary: 'Прайс: базовые ставки и модификаторы по позициям' })

export function registerPricingAdminRoutes(app: App, deps: Deps): void {
  app.get('/v1/admin/pricing', async (req) => {
    const s = await requirePermission(req.cookies[SESSION_COOKIE], 'price.manage')
    return getPricing(s, req.query as Record<string, unknown>, deps)
  })
}
