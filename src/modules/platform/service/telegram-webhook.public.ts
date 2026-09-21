/**
 * Вебхук Telegram-бота тенанта: связывание чата с клиентом.
 *
 * Механизм (../rental-docs/docs/04-тз/10-бэкенд/16-уведомления.md): кнопка в письме ведёт
 * на t.me/<бот>?start=<view-токен заказа>; Telegram передаёт payload
 * первым сообщением /start; бот по токену находит заказ и сохраняет
 * chat_id у клиента. С этого момента уведомления идут в мессенджер,
 * а не на почту.
 *
 * ⚠️ Бот принадлежит ТЕНАНТУ: вебхук адресуется slug'ом, а секрет
 * вебхука (X-Telegram-Bot-Api-Secret-Token) сверяется с настройкой
 * тенанта. Без сверки любой может прислать «/start <токен>» и увести
 * уведомления клиента в свой чат.
 *
 * ⚠️ Токен в payload — VIEW-токен: он даёт только просмотр заказа, и
 * его утечка в Telegram не открывает ни подтверждение, ни отмену.
 */
import type { Deps } from '~/kernel/deps'
import * as v from 'valibot'
import { locateByToken } from '~/domain/orders/order-token'

const Update = v.object({
  message: v.optional(v.object({
    text: v.optional(v.string()),
    chat: v.object({ id: v.union([v.number(), v.string()]) }),
    from: v.optional(v.object({ id: v.union([v.number(), v.string()]) })),
  })),
})

export interface PostTelegramInput {
  body: unknown
  params: Record<string, string>
  headers: Record<string, string | undefined>
}

export async function postTelegram(
  req: PostTelegramInput,
  deps: Deps,
) {
  const slug = req.params.slug ?? ''

  const tenants = await deps.db.unscoped<{ id: string, secret: string | null, token: string | null }>(
    `SELECT id,
            theme->'integrations'->>'telegramWebhookSecret' AS secret,
            theme->'integrations'->>'telegramBotToken' AS token
     FROM tenant WHERE slug = $1 AND archived_at IS NULL`,
    [slug],
  )
  const tenant = tenants[0]
  // Telegram ждёт 200 всегда, иначе будет ретраить. Молча игнорируем
  // неизвестного тенанта и неверный секрет — подсказывать нечего.
  if (!tenant?.secret) return { ok: true }
  if (req.headers['x-telegram-bot-api-secret-token'] !== tenant.secret) return { ok: true }

  const parsed = v.safeParse(Update, req.body)
  const msg = parsed.success ? parsed.output.message : undefined
  const text = msg?.text?.trim() ?? ''
  const m = /^\/start\s+([A-Za-z0-9_-]{20,64})$/.exec(text)
  if (!msg || !m) return { ok: true }

  const token = m[1]!
  const hit = await deps.db.txAnonymous((c) => locateByToken(c, token, 'view'))
  // Токен чужого тенанта или истёкший — не наш случай.
  if (!hit || hit.tenantId !== tenant.id) return { ok: true }

  const chatId = String(msg.chat.id)

  await deps.db.tx(tenant.id, async (c) => {
    // Связка на клиенте, а не на заказе: следующие заказы того же
    // человека тоже пойдут в Telegram без повторного /start.
    await c.query(
      `UPDATE customer SET messenger = 'telegram', messenger_chat_id = $2
       WHERE id = (SELECT customer_id FROM rental_order WHERE id = $1)`,
      [hit.orderId, chatId],
    )
    await c.query(
      `INSERT INTO event (tenant_id, aggregate_type, aggregate_id, kind, payload, actor_type)
       VALUES ($1, 'rental_order', $2, 'customer.telegram_linked', $3, 'customer')`,
      [tenant.id, hit.orderId, JSON.stringify({ chatId })],
    )
  })

  // Ответ в чат — через Bot API напрямую: это ответ на действие
  // пользователя здесь и сейчас, а не уведомление о событии, и outbox
  // ему не нужен.
  if (tenant.token) {
    await fetch(`https://api.telegram.org/bot${tenant.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: 'Готово: напоминания и ссылка подтверждения по вашему заказу будут приходить сюда.',
      }),
    }).catch(() => { /* ответ в чат не критичен: связка уже записана */ })
  }

  return { ok: true }
}
