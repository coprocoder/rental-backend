/**
 * Мутации модуля `availability`.
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
import { postBlackout, BlackoutBody } from '../service/blackout.mutation'
import { postOfflineReserve, OfflineReserveBody } from '../service/offline-reserve.mutation'

const Ok = v.object({ ok: v.literal(true) })

documentRoute({ method: 'post', path: '/v1/admin/blackout', scope: 'staff',
  body: BlackoutBody, response: Ok,
  summary: 'Отключение позиции на даты: ремонт, вывоз, инвентаризация' })
documentRoute({ method: 'post', path: '/v1/admin/offline-reserve', scope: 'staff',
  body: OfflineReserveBody, response: Ok,
  summary: 'Оффлайн-бронь: снятие наличия под запись вне системы' })

export function registerAvailabilityMutations(app: App, deps: Deps): void {
  app.post('/v1/admin/blackout', async (httpReq) => {
    const s = await requirePlanFeature(deps.db, httpReq.cookies[SESSION_COOKIE], 'inventory.manage', 'advancedInventory')
    return postBlackout(s, { body: httpReq.body }, deps)
  })
  app.post('/v1/admin/offline-reserve', async (httpReq) => {
    const s = await requirePlanFeature(deps.db, httpReq.cookies[SESSION_COOKIE], 'inventory.manage', 'advancedInventory')
    return postOfflineReserve(s, { body: httpReq.body }, deps)
  })
}
