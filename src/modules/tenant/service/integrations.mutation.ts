/**
 * Сохранение настроек интеграции (13.16).
 *
 * ⚠️ Токен ПРОВЕРЯЕТСЯ у провайдера до сохранения, а не принимается на
 * веру. Это и есть разница между «полем для ключа» и мастером: опечатка
 * в токене иначе обнаружится только когда клиент не получит ссылку
 * подтверждения, заказ истечёт и инвентарь освободится. Владелец при
 * этом будет уверен, что всё настроил.
 *
 * ⚠️ Пустое значение СТИРАЕТ настройку, а не игнорируется: отключить
 * интеграцию должно быть так же просто, как включить.
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import * as v from 'valibot'
import { apiError, mapDbError } from '~/kernel/errors'
import { audit } from '~/domain/core/order-lifecycle'

export const IntegrationsBody = v.object({
  provider: v.picklist(['telegram', 'max']),
  token: v.pipe(v.string(), v.maxLength(200)),
})

export interface PostIntegrationsRequest {
  body: unknown
}

export async function postIntegrations(
  session: Session,
  req: PostIntegrationsRequest,
  deps: Deps,
) {

  const parsed = v.safeParse(IntegrationsBody, req.body)
  if (!parsed.success) throw apiError('VALIDATION_FAILED', 'Проверьте данные')
  const { token } = parsed.output

  let botUsername: string | null = null
  const isMax = parsed.output.provider === 'max'

  if (token && isMax) {
    // ⚠️ Токен MAX проверяется тем же способом, что и Telegram: живой
    // ключ обязан ответить на /me, и он же отдаёт имя бота, без
    // которого нельзя построить deep-link.
    //
    // ⚠️ Authorization заголовком, а не query-параметром: передача
    // токена через query официально больше не поддерживается, и ключ
    // в адресе оседал бы в логах прокси.
    let res: Response
    try {
      res = await fetch('https://platform-api2.max.ru/me', {
        headers: { authorization: token },
      })
    } catch {
      throw apiError('UPSTREAM_UNAVAILABLE', 'Не удалось связаться с MAX — попробуйте позже')
    }
    if (!res.ok) {
      throw apiError('VALIDATION_FAILED', 'MAX не принял этот токен. Проверьте, что скопировали его целиком.')
    }
    const body = await res.json().catch(() => null) as { username?: string, name?: string } | null
    botUsername = body?.username ?? null
  } else if (token) {
    // ⚠️ getMe — самая дешёвая проверка: она же подтверждает, что токен
    // живой, и заодно даёт имя бота, которое нужно клиенту для
    // deep-link. Без имени ссылка «написать боту» построить нельзя.
    let res: Response
    try {
      res = await fetch(`https://api.telegram.org/bot${token}/getMe`)
    } catch {
      // Сеть недоступна — это не «неверный токен», и говорить надо разное:
      // иначе владелец начнёт перевыпускать рабочий ключ.
      throw apiError('UPSTREAM_UNAVAILABLE', 'Не удалось связаться с Telegram — попробуйте позже')
    }
    if (!res.ok) {
      throw apiError('VALIDATION_FAILED', 'Telegram не принял этот токен. Проверьте, что скопировали его целиком.')
    }
    const body = await res.json().catch(() => null) as { result?: { username?: string } } | null
    botUsername = body?.result?.username ?? null
  }

  try {
    return await deps.db.tx(session.tenantId, async (c) => {
      // Ключи полей зависят от провайдера: у каждого мессенджера свой
      // бот, и подключение одного не должно отключать другой.
      const tokenKey = isMax ? 'maxBotToken' : 'telegramBotToken'
      const nameKey = isMax ? 'maxBotUsername' : 'telegramBotUsername'

      await c.query(
        `UPDATE tenant
         SET theme = jsonb_set(
           COALESCE(theme, '{}'::jsonb),
           '{integrations}',
           COALESCE(theme->'integrations', '{}'::jsonb)
             || jsonb_build_object($4::text, $2::text, $5::text, $3::text),
           true)
         WHERE id = $1`,
        [session.tenantId, token || null, botUsername, tokenKey, nameKey],
      )

      // ⚠️ В журнал пишется ФАКТ смены, но НЕ значение: audit_log
      // читают сотрудники, и токен в нём — это второй способ его
      // утечки после браузера.
      await audit(c, {
        tenantId: session.tenantId,
        staffId: session.staffId,
        action: 'integration.updated',
        targetType: 'tenant',
        targetId: session.tenantId,
        reason: token
          ? `подключён бот ${isMax ? 'MAX' : 'Telegram'}`
          : `отключена интеграция ${isMax ? 'MAX' : 'Telegram'}`,
        after: { provider: parsed.output.provider, botUsername, configured: Boolean(token) },
      })

      return { ok: true, botUsername }
    })
  } catch (err) {
    throw mapDbError(err)
  }
}
