/**
 * Состояние интеграций (13.16).
 *
 * ⚠️ Секреты НЕ ВОЗВРАЩАЮТСЯ — только признак «настроено» и хвост
 * значения для узнавания. Отдать токен обратно в браузер значит
 * положить его в историю запросов, в кеш девтулзов и в скриншот,
 * который сотрудник пришлёт в поддержку. Узнать свой токен владелец
 * может у того, кто его выдал; наша задача — показать, работает ли он.
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'

/** Хвост секрета: достаточно, чтобы узнать «тот ли это ключ». */
function tail(v: unknown): string | null {
  return typeof v === 'string' && v.length > 4 ? `…${v.slice(-4)}` : null
}

export async function getIntegrations(session: Session, deps: Deps) {

  return deps.db.tx(session.tenantId, async (c) => {
    const { rows } = await c.query<{ integrations: Record<string, unknown> | null }>(
      `SELECT theme->'integrations' AS integrations FROM tenant WHERE id = $1`,
      [session.tenantId],
    )
    const i = rows[0]?.integrations ?? {}

    return {
      telegram: {
        configured: typeof i.telegramBotToken === 'string' && i.telegramBotToken.length > 0,
        tail: tail(i.telegramBotToken),
        botUsername: typeof i.telegramBotUsername === 'string' ? i.telegramBotUsername : null,
      },
      max: {
        configured: typeof i.maxBotToken === 'string' && i.maxBotToken.length > 0,
        tail: tail(i.maxBotToken),
        botUsername: typeof i.maxBotUsername === 'string' ? i.maxBotUsername : null,
      },
      // Эквайринг и касса в v1 работают заглушкой: поля есть, чтобы
      // при подключении не переделывать модель (⏸ по TODO 11.x).
      payment: {
        configured: typeof i.paymentProvider === 'string' && i.paymentProvider !== 'stub',
        provider: typeof i.paymentProvider === 'string' ? i.paymentProvider : 'stub',
      },
      fiscal: {
        configured: typeof i.fiscalProvider === 'string' && i.fiscalProvider !== 'stub',
        provider: typeof i.fiscalProvider === 'string' ? i.fiscalProvider : 'stub',
      },
    }
  })
}
