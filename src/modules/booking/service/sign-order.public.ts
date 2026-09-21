/**
 * Подписание договора: запрос кода и приём кода.
 *
 * Два действия в одном эндпоинте, потому что это один шаг для клиента:
 * без кода — запросить, с кодом — подписать.
 *
 * ⚠️ Доступ по токену просмотра, а не подтверждения: подписать договор
 * может тот, у кого ссылка на заказ, и это тот же человек, что получит
 * снаряжение. Отдельный токен здесь ничего не добавил бы — код в
 * мессенджер и есть второй фактор.
 */
import type { Deps } from '~/kernel/deps'
import * as v from 'valibot'
import { apiError, mapDbError } from '~/kernel/errors'
import { locateByToken } from '~/domain/orders/order-token'
import { requestSignCode, signAgreement } from '~/domain/orders/agreement'

export const SignBody = v.optional(v.object({
  /** Без кода — запрос кода. С кодом — подписание. */
  code: v.optional(v.pipe(v.string(), v.minLength(4), v.maxLength(10))),
}))

export interface PostSignInput {
  ip: string
  body: unknown
  params: Record<string, string>
}

export async function postSign(
  req: PostSignInput,
  deps: Deps,
) {
  const token = req.params.token ?? ''
  const hit = await deps.db.txAnonymous((c) => locateByToken(c, token, 'view'))
  if (!hit) throw apiError('NOT_FOUND', 'Ссылка недействительна или истекла')

  const parsed = v.safeParse(SignBody, req.body)
  const code = parsed.success ? parsed.output?.code : undefined

  try {
    return await deps.db.tx(hit.tenantId, async (c) => {
      const { rows } = await c.query<{
        phone: string | null
        chat_id: string | null
        messenger: 'telegram' | 'max' | null
        email: string | null
      }>(
        `SELECT cu.phone, cu.messenger_chat_id AS chat_id, cu.messenger, cu.email
         FROM rental_order o
         LEFT JOIN customer cu ON cu.id = o.customer_id
         WHERE o.id = $1`,
        [hit.orderId],
      )
      const contact = rows[0]
      const phone = contact?.phone
      if (!phone) throw apiError('VALIDATION_FAILED', 'У заказа нет телефона клиента')

      // ⚠️ Канал должен совпадать с фактической доставкой: SMS в MVP
      // нет вовсе, поэтому при отсутствии связанного чата код уходит
      // на email, и в договоре пишется email — иначе запись о канале
      // оказалась бы ложной, а это доказательство подписи.
      const channel: 'telegram' | 'max' | 'email' | null =
        contact.chat_id && contact.messenger
          ? contact.messenger
          : contact.email
            ? 'email'
            : null

      if (!channel) {
        throw apiError(
          'VALIDATION_FAILED',
          'Подписать договор нечем: подключите мессенджер или укажите почту',
        )
      }

      if (!code) {
        const { expiresAt } = await requestSignCode(c, {
          tenantId: hit.tenantId, orderId: hit.orderId, phone,
        })
        return { sent: true, expiresAt: expiresAt.toISOString() }
      }

      const signed = await signAgreement(c, {
        tenantId: hit.tenantId,
        orderId: hit.orderId,
        code,
        phone,
        ip: req.ip,
        channel,
        messengerChatId: contact.chat_id ?? undefined,
      })

      return {
        signed: true,
        version: signed.version,
        signedAt: signed.signedAt.toISOString(),
      }
    })
  } catch (err) {
    throw mapDbError(err)
  }
}
