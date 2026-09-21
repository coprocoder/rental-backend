/**
 * Рубильники тенанта (17.19) — чтение.
 *
 * ⚠️ Тенант ВИДИТ свои рубильники, но не ставит их: увидеть, почему
 * у тебя выключено бронирование, он должен обязательно, иначе
 * обращение в поддержку начинается с «у нас всё сломалось».
 * Ставит их платформа.
 *
 * ⚠️ Исключение — online_booking: его прокат гасит сам, на время
 * инвентаризации. Это его собственная операция, а не вмешательство
 * платформы.
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import { activeFlags, FLAGS } from '~/domain/core/flags'

/** Что прокат может переключать сам. Остальное — только платформа. */
export const SELF_SERVICE_FLAGS = ['online_booking'] as const

export async function getFlags(session: Session, deps: Deps) {

  return deps.db.tx(session.tenantId, async (c) => {
    const active = await activeFlags(c, session.tenantId)

    return {
      flags: Object.entries(FLAGS).map(([flag, title]) => {
        const set = active.get(flag)
        return {
          flag,
          title,
          // Умолчание — включено: рубильник это исключение, а не режим.
          enabled: set?.enabled ?? true,
          overridden: Boolean(set),
          reason: set?.reason ?? null,
          until: set?.until ?? null,
          selfService: (SELF_SERVICE_FLAGS as readonly string[]).includes(flag),
        }
      }),
    }
  })
}
