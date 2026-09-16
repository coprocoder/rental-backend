/**
 * Продление аренды клиентом по ссылке.
 *
 * ⚠️ Продление возможно удалённо, без визита на стойку — это частый
 * и приятный сценарий (../rental-docs/docs/04-тз/10-бэкенд/19-нештатные-ситуации.md).
 *
 * ⚠️ Наличие проверяется на добавляемый отрезок: вещь может быть уже
 * забронирована другим. Отказ объясняется, а не просто отклоняется.
 */
import type { Deps } from '~/kernel/deps'
import * as v from 'valibot'
import { apiError, mapDbError } from '~/kernel/errors'
import { locateByToken } from '~/domain/orders/order-token'
import { extendRental } from '~/domain/core/exceptions'

const Body = v.object({
  newEndsAt: v.pipe(v.string(), v.isoTimestamp()),
})

export interface PostExtendInput {
  body: unknown
  params: Record<string, string>
}

export async function postExtend(
  req: PostExtendInput,
  deps: Deps,
) {
  const token = req.params.token ?? ''
  const hit = await deps.db.txAnonymous((c) => locateByToken(c, token, 'view'))
  if (!hit) throw apiError('NOT_FOUND', 'Ссылка недействительна или истекла')

  const parsed = v.safeParse(Body, req.body)
  if (!parsed.success) throw apiError('VALIDATION_FAILED', 'Укажите новую дату окончания')

  try {
    return await deps.db.tx(hit.tenantId, (c) => extendRental(c, {
      tenantId: hit.tenantId,
      orderId: hit.orderId,
      newEndsAt: new Date(parsed.output.newEndsAt),
    }))
  } catch (err) {
    throw mapDbError(err)
  }
}
