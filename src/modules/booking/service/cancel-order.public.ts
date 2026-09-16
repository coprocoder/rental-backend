/**
 * Самостоятельная отмена заказа клиентом.
 *
 * ⚠️ Отмена ПООЩРЯЕТСЯ, а не отговаривается: освободившийся инвентарь
 * продаётся снова (../rental-docs/docs/04-тз/10-бэкенд/17-доступ-и-роли.md). Поэтому нет
 * ни «вы уверены?», ни лишних шагов — формулировка нейтральная.
 *
 * По ТЗ необратимые действия требуют кода в мессенджер, но в MVP
 * мессенджера нет, и там же сказано: «без привязки — только ссылка».
 * Цена ошибки невелика: предоплаты нет, инвентарь вернётся в продажу.
 *
 * Отдельный токен от просмотра: утечка ссылки «посмотреть заказ» не
 * должна давать возможность его отменить.
 */
import type { Deps } from '~/kernel/deps'
import * as v from 'valibot'
import { apiError, mapDbError } from '~/kernel/errors'
import { locateByToken, markTokenUsed } from '~/domain/orders/order-token'
import { transition } from '~/domain/core/order-lifecycle'

const Body = v.optional(v.object({
  /** Причина со стороны клиента — необязательна, но полезна для спроса. */
  reason: v.optional(v.pipe(v.string(), v.maxLength(500))),
}))

export interface PostCancelInput {
  headers: Record<string, string | undefined>
  body: unknown
  params: Record<string, string>
}

export async function postCancel(
  req: PostCancelInput,
  deps: Deps,
) {
  const token = req.params.token ?? ''
  const parsed = v.safeParse(Body, req.body)
  const reason = parsed.success ? parsed.output?.reason : undefined

  const hit = await deps.db.txAnonymous((c) => locateByToken(c, token, 'cancel'))
  if (!hit) throw apiError('NOT_FOUND', 'Ссылка недействительна или истекла')

  try {
    return await deps.db.tx(hit.tenantId, async (c) => {
      const { changed, from, order } = await transition(c, {
        orderId: hit.orderId,
        to: 'cancelled',
        actor: { type: 'customer' },
        correlationId: req.headers?.["x-correlation-id"],
        // Причина отмены — сигнал спроса: «нашёл дешевле», «планы».
        payload: reason ? { reason } : undefined,
      })

      await markTokenUsed(c, token, 'cancel')

      return {
        code: order.public_code,
        status: 'cancelled',
        alreadyCancelled: !changed,
        previousStatus: from,
      }
    })
  } catch (err) {
    throw mapDbError(err)
  }
}
