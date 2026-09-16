/** Публичные маршруты заказа и юридических документов. */
import * as v from 'valibot'
import type { App } from '~/transport/types'
import type { Deps } from '~/kernel/deps'
import { parse } from '~/transport/validate'
import { apiError } from '~/kernel/errors'
import { DOCUMENT_KINDS, getDocument, type DocumentKind } from '../service/agreement.service'

const OfferQuery = v.object({
  tenant: v.pipe(v.string('Не указан тенант'), v.minLength(1, 'Не указан тенант')),
  kind: v.optional(v.string(), 'offer'),
})

export function registerBookingRoutes(app: App, deps: Deps): void {
  app.get('/v1/public/agreement/offer', async (req) => {
    const q = parse(OfferQuery, req.query)
    if (!DOCUMENT_KINDS.includes(q.kind as DocumentKind)) {
      throw apiError('VALIDATION_FAILED', 'Неизвестный вид документа')
    }
    return getDocument({ tenant: q.tenant, kind: q.kind as DocumentKind }, deps)
  })
}
