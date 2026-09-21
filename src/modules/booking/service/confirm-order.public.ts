/**
 * Подтверждение брони клиентом — одно нажатие по ссылке.
 *
 * На этом механизме держится защита от блокировки арсенала
 * (../rental-docs/docs/04-тз/10-бэкенд/12-наличие-и-жизненный-цикл.md): бронь живёт до
 * дедлайна подтверждения, а не «до даты». Удержать 30 бордов стоит
 * 30 подтверждений — при нулевой цене в рублях.
 *
 * ⚠️ Ни кода, ни второго шага: строгость здесь убьёт сам механизм.
 * Цена ошибочного подтверждения — ноль, цена неподтверждённой брони —
 * заблокированный инвентарь.
 *
 * ⚠️ Идемпотентно: люди жмут ссылку дважды, и второе нажатие означает
 * «уже подтверждено», а не ошибку.
 */
import type { Deps } from '~/kernel/deps'
import { apiError, mapDbError } from '~/kernel/errors'
import { locateByToken, markTokenUsed } from '~/domain/orders/order-token'
import { transition } from '~/domain/core/order-lifecycle'

export interface PostConfirmInput {
  headers: Record<string, string | undefined>
  params: Record<string, string>
}

export async function postConfirm(
  req: PostConfirmInput,
  deps: Deps,
) {
  const token = req.params.token ?? ''

  const hit = await deps.db.txAnonymous((c) => locateByToken(c, token, 'confirm'))
  if (!hit) throw apiError('NOT_FOUND', 'Ссылка недействительна или истекла')

  try {
    return await deps.db.tx(hit.tenantId, async (c) => {
      const { changed, from, order } = await transition(c, {
        orderId: hit.orderId,
        to: 'confirmed',
        actor: { type: 'customer' },
        correlationId: req.headers?.["x-correlation-id"],
      })

      await markTokenUsed(c, token, 'confirm')

      return {
        code: order.public_code,
        status: 'confirmed',
        // Клиенту важно различать «подтвердили» и «уже было подтверждено»:
        // иначе повторное нажатие выглядит как сбой.
        alreadyConfirmed: !changed,
        previousStatus: from,
      }
    })
  } catch (err) {
    throw mapDbError(err)
  }
}
