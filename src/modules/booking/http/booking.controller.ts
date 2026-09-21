/** Публичные маршруты заказа и юридических документов. */
import * as v from 'valibot'
import type { App } from '~/transport/types'
import type { Deps } from '~/kernel/deps'
import { parse } from '~/transport/validate'
import { apiError } from '~/kernel/errors'
import { DOCUMENT_KINDS, getDocument, type DocumentKind } from '../service/agreement.service'
import { documentPage, wantsHtml } from '~/transport/html'
import { documentRoute } from '~/transport/openapi/registry'
import { TEXT_KINDS } from '~/domain/admin/texts'

const OfferQuery = v.object({
  tenant: v.pipe(v.string('Не указан тенант'), v.minLength(1, 'Не указан тенант')),
  kind: v.optional(v.string(), 'offer'),
})

/**
 * Ответ с юридическим документом.
 *
 * ⚠️ Отдаётся и как JSON (этот вид), и как HTML-страница — по заголовку
 * `Accept` (19.44). Схема описывает JSON: HTML читает человек, а не код.
 *
 * ⚠️ `hash` есть не всегда: у оферты, взятой из фолбэка `theme`
 * (тенанты, заведённые до версионирования), его нет.
 */
const DocumentResponse = v.object({
  version: v.string(),
  text: v.string(),
  hash: v.optional(v.string()),
})

documentRoute({
  method: 'get',
  path: '/v1/public/agreement/offer',
  summary: 'Договор проката, политика ПД или правила — действующая редакция',
  scope: 'public',
  query: OfferQuery,
  response: DocumentResponse,
})

export function registerBookingRoutes(app: App, deps: Deps): void {
  /**
   * Юридический документ: оферта, политика ПД, правила проката.
   *
   * ⚠️ Один адрес, две формы ответа — по заголовку `Accept`.
   * Браузер по ссылке из формы бронирования просит `text/html` и
   * получает читаемую страницу; `fetch` из кода получает прежний JSON.
   * Менять форму для всех было нельзя: это публичный API, и виджет
   * встраивается в чужие сайты (19.44).
   *
   * ⚠️ Раньше отдавался только JSON, и человек, нажавший «условия
   * аренды» рядом с чекбоксом «соглашаюсь», видел
   * `{"version":"v1","text":"⚠️ ТИПОВАЯ…` с экранированными переносами.
   * Это текст, под которым он ставит подпись.
   */
  app.get('/v1/public/agreement/offer', async (req, reply) => {
    const q = parse(OfferQuery, req.query)
    if (!DOCUMENT_KINDS.includes(q.kind as DocumentKind)) {
      throw apiError('VALIDATION_FAILED', 'Неизвестный вид документа')
    }
    const kind = q.kind as DocumentKind
    const doc = await getDocument({ tenant: q.tenant, kind }, deps)

    if (!wantsHtml(req.headers.accept)) return doc

    // ⚠️ Название берётся из общего списка видов, а не пишется здесь
    // второй раз: иначе экран текстов в админке и документ для клиента
    // однажды назовут одно и то же по-разному.
    const title = TEXT_KINDS.find((t) => t.kind === kind)?.title ?? 'Документ'
    reply.header('content-type', 'text/html; charset=utf-8')
    return documentPage({ title, version: doc.version, text: doc.text })
  })
}
