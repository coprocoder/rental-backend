/**
 * Новая редакция текста (13.14).
 *
 * ⚠️ Всегда НОВАЯ редакция, никогда правка существующей: клиент
 * подписал конкретный текст, его хеш лежит в agreement, и изменить
 * подписанное задним числом нельзя — иначе подпись перестаёт что-либо
 * доказывать в споре, который разбирается через год.
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import * as v from 'valibot'
import { apiError, mapDbError } from '~/kernel/errors'
import { publishVersion } from '~/domain/admin/texts'

const Body = v.object({
  kind: v.picklist(['offer', 'privacy', 'rules']),
  // Верхняя граница щедрая: оферта на несколько страниц — норма.
  body: v.pipe(v.string(), v.minLength(1), v.maxLength(100_000)),
})

export interface PostTextsRequest {
  body: unknown
}

export async function postTexts(
  session: Session,
  req: PostTextsRequest,
  deps: Deps,
) {

  const parsed = v.safeParse(Body, req.body)
  if (!parsed.success) throw apiError('VALIDATION_FAILED', 'Текст не может быть пустым')

  try {
    return await deps.db.tx(session.tenantId, (c) => publishVersion(c, {
      tenantId: session.tenantId,
      kind: parsed.output.kind,
      body: parsed.output.body,
      staffId: session.staffId,
    }))
  } catch (err) {
    throw mapDbError(err)
  }
}
