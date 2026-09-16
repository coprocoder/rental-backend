/**
 * Вебхук MAX: связывание чата клиента с его заказом (8.4).
 *
 * ⚠️ MAX поддерживает deep-link со start-payload — подтверждено
 * официальной документацией (dev.max.ru). Клиент нажимает ссылку
 * `https://max.ru/{bot}?start={viewToken}`, бот получает обновление
 * `bot_started` с полем `payload`, и по нему находится заказ.
 * Запасной путь со связкой коротким кодом не понадобился.
 *
 * ⚠️ Отличие от Telegram: там токен приходит текстом команды
 * `/start {payload}` в обычном сообщении, здесь — отдельным типом
 * обновления и готовым полем. Разбирать текст не нужно, и это надёжнее.
 *
 * ⚠️ Отвечаем 200 всегда, как и Telegram: иначе MAX будет повторять
 * доставку. Неизвестный тенант, неверный секрет и чужой токен молча
 * игнорируются — подсказывать тому, кто стучится наугад, нечего.
 */
import type { Deps } from '~/kernel/deps'
import * as v from 'valibot'
import { locateByToken } from '~/domain/orders/order-token'

const Update = v.object({
  update_type: v.optional(v.string()),
  chat_id: v.optional(v.union([v.number(), v.string()])),
  /** До 128 символов; наш view-токен — 43 base64url. */
  payload: v.optional(v.nullable(v.string())),
  user: v.optional(v.object({
    user_id: v.optional(v.union([v.number(), v.string()])),
  })),
})

export interface PostMaxInput {
  body: unknown
  params: Record<string, string>
  headers: Record<string, string | undefined>
}

export async function postMax(
  req: PostMaxInput,
  deps: Deps,
) {
  const slug = req.params.slug ?? ''

  const tenants = await deps.db.unscoped<{ id: string, secret: string | null }>(
    `SELECT id, theme->'integrations'->>'maxWebhookSecret' AS secret
     FROM tenant WHERE slug = $1 AND archived_at IS NULL`,
    [slug],
  )
  const tenant = tenants[0]
  if (!tenant?.secret) return { ok: true }

  // ⚠️ Секрет сверяется до разбора тела: без него вебхук — открытая
  // дверь, через которую чужой чат привязывается к чужому заказу.
  if (req.headers['x-max-webhook-secret'] !== tenant.secret) return { ok: true }

  const parsed = v.safeParse(Update, req.body)
  if (!parsed.success) return { ok: true }
  const u = parsed.output

  // Интересует только запуск бота по ссылке: остальные обновления
  // (сообщения, выходы из чата) к связыванию отношения не имеют.
  if (u.update_type !== 'bot_started') return { ok: true }

  const token = (u.payload ?? '').trim()
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) return { ok: true }
  if (u.chat_id === undefined || u.chat_id === null) return { ok: true }

  const hit = await deps.db.txAnonymous((c) => locateByToken(c, token, 'view'))
  // Токен чужого тенанта или истёкший — не наш случай.
  if (!hit || hit.tenantId !== tenant.id) return { ok: true }

  const chatId = String(u.chat_id)

  await deps.db.tx(tenant.id, async (c) => {
    // ⚠️ Связка на КЛИЕНТЕ, а не на заказе: следующие заказы того же
    // человека тоже пойдут в MAX без повторного перехода по ссылке.
    await c.query(
      `UPDATE customer SET messenger = 'max', messenger_chat_id = $2
       WHERE id = (SELECT customer_id FROM rental_order WHERE id = $1)`,
      [hit.orderId, chatId],
    )
    await c.query(
      `INSERT INTO event (tenant_id, aggregate_type, aggregate_id, kind, payload, actor_type)
       VALUES ($1, 'rental_order', $2, 'customer.max_linked', $3, 'customer')`,
      [tenant.id, hit.orderId, JSON.stringify({ chatId })],
    )
  })

  return { ok: true }
}
