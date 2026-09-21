/**
 * Переключение рубильника прокатом (17.19).
 *
 * ⚠️ Прокат может гасить ТОЛЬКО online_booking — свою собственную
 * операцию на время инвентаризации. Остальные рубильники ставит
 * платформа: смысл в том, чтобы поддержка могла погасить функцию,
 * в том числе когда у самого проката всё «работает», и отдавать
 * этот рычаг тенанту значит его обессмыслить.
 *
 * ⚠️ Причина обязательна и проверяется дважды — здесь и CHECK'ом
 * в БД: через месяц «почему у них не принимаются заказы» иначе
 * не выяснить.
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import * as v from 'valibot'
import { getWorkerPool } from '~/kernel/db'
import { apiError, mapDbError } from '~/kernel/errors'
import { clearFlag, setFlag } from '~/domain/core/flags'
import { SELF_SERVICE_FLAGS } from './admin-flags.service'

export const FlagsBody = v.object({
  flag: v.picklist(['online_booking']),
  enabled: v.boolean(),
  reason: v.pipe(v.string(), v.minLength(3, 'Опишите причину'), v.maxLength(500)),
  /** Сам снимется: «выключили на инвентаризацию до завтра». */
  until: v.optional(v.nullable(v.pipe(v.string(), v.isoTimestamp()))),
})

export interface PostFlagsRequest {
  body: unknown
}

export async function postFlags(
  session: Session,
  req: PostFlagsRequest,
  deps: Deps,
) {

  const parsed = v.safeParse(FlagsBody, req.body)
  if (!parsed.success) {
    throw apiError('VALIDATION_FAILED', parsed.issues[0]?.message ?? 'Проверьте запрос')
  }
  const input = parsed.output

  if (!(SELF_SERVICE_FLAGS as readonly string[]).includes(input.flag)) {
    throw apiError('FORBIDDEN', 'Этот рубильник переключает только поддержка')
  }

  // ⚠️ Пишем ЧЕРЕЗ РАБОЧУЮ РОЛЬ, а не через прикладную. У tenant_flag
  // нет RLS (рубильники ставит платформа), поэтому единственная
  // граница — права роли: rental_app только читает, иначе тенант снял
  // бы с себя ограничение, поставленное поддержкой. Здесь тот же
  // запрет обходится осознанно и в одном месте — после проверки,
  // что рубильник из списка самообслуживания и что tenant_id взят
  // из сессии, а не из тела запроса.
  const c = await getWorkerPool().connect()
  try {
    // ⚠️ Включение обратно СНИМАЕТ рубильник, а не ставит «включено».
    // Разница в том, что снятый рубильник возвращает тенанта под
    // умолчание тарифа, а «включено» переопределяло бы его навсегда —
    // и завтрашнее изменение плана до проката бы не дошло.
    if (input.enabled) {
      await clearFlag(c, { tenantId: session.tenantId, flag: input.flag })
    } else {
      await setFlag(c, {
        tenantId: session.tenantId,
        flag: input.flag,
        enabled: false,
        reason: input.reason,
        until: input.until ? new Date(input.until) : null,
        staffId: session.staffId,
      })
    }
    return { ok: true }
  } catch (err) {
    throw mapDbError(err)
  } finally {
    c.release()
  }
}
