/**
 * Маршруты стойки: выдача, возврат, смена, ревизия.
 *
 * ⚠️ Все требуют только ВХОДА, без отдельного права: стойка — рабочее
 * место, и сотрудник за ней уже прошёл проверку при входе.
 */
import type { App } from '~/transport/types'
import type { Deps } from '~/kernel/deps'
import { SESSION_COOKIE, requireSession } from '~/kernel/session'
import { getCatalog } from '../service/catalog.service'
import { getFreeItems } from '../service/free-items.service'
import { getHistory } from '../service/history.service'
import { getItemLookup } from '../service/item-lookup.service'
import { getOrders } from '../service/orders.service'
import { getShift } from '../service/shift.service'
import { getUpsell } from '../service/upsell.service'

export function registerCounterRoutes(app: App, deps: Deps): void {
  app.get('/v1/counter/catalog', async (req) => {
    const s = await requireSession(req.cookies[SESSION_COOKIE])
    return getCatalog(s, req.query as Record<string, unknown>, deps)
  })
  app.get('/v1/counter/free-items', async (req) => {
    const s = await requireSession(req.cookies[SESSION_COOKIE])
    return getFreeItems(s, req.query as Record<string, unknown>, deps)
  })
  app.get('/v1/counter/history', async (req) => {
    const s = await requireSession(req.cookies[SESSION_COOKIE])
    return getHistory(s, req.query as Record<string, unknown>, deps)
  })
  app.get('/v1/counter/item-lookup', async (req) => {
    const s = await requireSession(req.cookies[SESSION_COOKIE])
    return getItemLookup(s, req.query as Record<string, unknown>, deps)
  })
  app.get('/v1/counter/orders', async (req) => {
    const s = await requireSession(req.cookies[SESSION_COOKIE])
    return getOrders(s, req.query as Record<string, unknown>, deps)
  })
  app.get('/v1/counter/shift', async (req) => {
    const s = await requireSession(req.cookies[SESSION_COOKIE])
    return getShift(s, req.query as Record<string, unknown>, deps)
  })
  app.get('/v1/counter/upsell', async (req) => {
    const s = await requireSession(req.cookies[SESSION_COOKIE])
    return getUpsell(s, req.query as Record<string, unknown>, deps)
  })
}
