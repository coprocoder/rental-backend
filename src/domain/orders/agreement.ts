/**
 * Оферта и простая электронная подпись (ПЭП).
 *
 * Правовая основа (../rental-docs/docs/04-тз/00-общее/04-правовое.md): прокат требует
 * письменной формы, но электронная её удовлетворяет — оферта плюс
 * приём кодом как ПЭП (ГК 434 п. 2 + 160 + 438).
 *
 * ⚠️ Логируется НЕ только факт подписания: версия оферты, её хеш,
 * время, телефон, IP и идентификатор чата мессенджера. Без хеша нельзя
 * доказать, ЧТО именно человек принял — текст оферты через год другой,
 * а версия без хеша не защищает от правки текста задним числом.
 *
 * ⚠️ Канал кода в MVP — мессенджер, не SMS: у SMS абонентская плата за
 * буквенное имя отправителя около 10 тыс. ₽ до первого сообщения.
 *
 * ⚠️ Известный юридический риск, зафиксированный сознательно: код в
 * мессенджере слабее SMS как доказательство — при SMS телефон
 * подтверждён оператором связи, в мессенджере только аккаунтом. Риск
 * снижается тремя способами: логируется идентификатор чата, для лыж и
 * сноубордов остаётся бумажная подпись на стойке (она там нужна под
 * DIN-ответственностью), а ПЭП по SMS остаётся опцией тенанта.
 *
 * ⚠️ Подписывает тот, кто ПОЛУЧАЕТ снаряжение. Если пришёл не тот
 * человек — это переоформление договора, а не «подпись за другого».
 */
import { randomInt } from 'node:crypto'
import type { PoolClient } from 'pg'
import { apiError } from '~/kernel/errors'
import { activeText } from '../admin/texts'
import { hashText } from '~/common/utils/hash-text'
import { offerDraft } from '../admin/texts.templates'

/** Сколько живёт код подтверждения. */
const CODE_TTL_MINUTES = 15

export interface OfferText {
  version: string
  /** Полный текст, который увидит клиент. */
  text: string
  hash: string
}

/**
 * Текст оферты тенанта.
 *
 * ⚠️ Хеш считается от ТОГО ЖЕ текста, что показан клиенту: если
 * показывать одно, а хешировать другое, подпись ничего не доказывает.
 *
 * ⚠️ Источник — действующая редакция в tenant_text (13.14), и только
 * при её отсутствии старое поле theme->>'offerText'. Порядок именно
 * такой: у тенантов, заведённых до версионирования, текст лежит в теме,
 * и потерять его при переходе нельзя — договор перестал бы существовать.
 */
export async function offerFor(
  c: PoolClient,
  tenantId: string,
): Promise<OfferText> {
  const versioned = await activeText(c, { tenantId, kind: 'offer' })
  if (versioned) {
    return {
      version: `v${versioned.version}`,
      text: versioned.body,
      // Хеш берётся сохранённый, а не считается заново: он вычислен от
      // того же тела при публикации, и пересчёт лишь даёт шанс разойтись.
      hash: versioned.hash,
    }
  }

  const { rows } = await c.query<{
    offer_text: string | null
    offer_version: string | null
    name: string
  }>(
    `SELECT theme->>'offerText' AS offer_text,
            theme->>'offerVersion' AS offer_version,
            name
     FROM tenant WHERE id = $1`,
    [tenantId],
  )
  const t = rows[0]
  if (!t) throw apiError('TENANT_NOT_FOUND', 'Прокат не найден')

  // Тенант не заполнил оферту — берётся текст платформы по умолчанию.
  // Молчать нельзя: без оферты договора нет вовсе.
  const text = t.offer_text ?? offerDraft(t.name)
  const version = t.offer_version ?? 'platform-v1'

  return { version, text, hash: hashText(text) }
}

/**
 * Выдаёт код подтверждения и кладёт отправку в outbox.
 *
 * Код короткий, потому что его вводит человек с телефона. Защита не в
 * длине, а в TTL и ограничении попыток: подобрать шестизначный код за
 * 15 минут при трёх попытках нельзя.
 */
export async function requestSignCode(
  c: PoolClient,
  opts: { tenantId: string, orderId: string, phone: string },
): Promise<{ expiresAt: Date }> {
  const code = String(randomInt(100_000, 1_000_000))
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60_000)

  // ⚠️ Хранится ХЕШ кода: дамп базы не должен позволять подписать
  // договор за клиента.
  // ⚠️ purpose = 'sign', а не 'confirm': код подписи и ссылка
  // подтверждения брони — разные механизмы с разным сроком жизни,
  // и пометка «использован» на одном не должна задевать другой.
  await c.query(
    `INSERT INTO order_token (tenant_id, order_id, purpose, token_hash, expires_at)
     VALUES ($1, $2, 'sign', $3, $4)`,
    [opts.tenantId, opts.orderId, hashText(`sign:${opts.orderId}:${code}`), expiresAt],
  )

  await c.query(
    `INSERT INTO outbox (tenant_id, kind, payload, idempotency_key)
     VALUES ($1, 'agreement.sign_code', $2, $3)
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
    [
      opts.tenantId,
      JSON.stringify({ orderId: opts.orderId, phone: opts.phone, code }),
      // Ключ включает время: повторный запрос кода — законное действие
      // (не дошло, истекло), и схлопывать его нельзя.
      `sign:${opts.orderId}:${Date.now()}`,
    ],
  )

  return { expiresAt }
}

/**
 * Проверяет код и фиксирует подписание.
 *
 * ⚠️ Всё, что нужно для доказательства, пишется одной записью и в той
 * же транзакции: версия, хеш, время, телефон, IP, идентификатор чата.
 * Собирать это потом по разным таблицам — значит не собрать.
 */
export async function signAgreement(
  c: PoolClient,
  opts: {
    tenantId: string
    orderId: string
    code: string
    phone: string
    ip?: string
    /**
     * Канал, которым фактически доставлен код.
     *
     * ⚠️ Пишется тот, которым код РЕАЛЬНО ушёл, а не желаемый: это
     * доказательство подписи. 'email' слабее мессенджера, 'sms' в MVP
     * не используется, 'paper' — подпись на стойке под DIN.
     */
    channel?: 'telegram' | 'max' | 'email' | 'sms' | 'paper'
    messengerChatId?: string
  },
): Promise<{ version: string, signedAt: Date }> {
  const hash = hashText(`sign:${opts.orderId}:${opts.code}`)

  const { rows: tokens } = await c.query<{ id: string }>(
    `SELECT id FROM order_token
     WHERE order_id = $1 AND purpose = 'sign'
       AND token_hash = $2 AND expires_at > now() AND used_at IS NULL`,
    [opts.orderId, hash],
  )
  if (!tokens[0]) throw apiError('FORBIDDEN', 'Код неверен или истёк')

  await c.query(`UPDATE order_token SET used_at = now() WHERE id = $1`, [tokens[0].id])

  const offer = await offerFor(c, opts.tenantId)

  const { rows } = await c.query<{ signed_at: Date }>(
    `INSERT INTO agreement
       (tenant_id, order_id, offer_version, offer_hash, sign_channel,
        phone, ip, messenger_chat_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING signed_at`,
    [
      opts.tenantId, opts.orderId, offer.version, offer.hash,
      opts.channel ?? 'telegram', opts.phone, opts.ip ?? null,
      opts.messengerChatId ?? null,
    ],
  )

  // Событие — в той же транзакции: подписание меняет состояние заказа
  // юридически, и хронология обязана это показывать.
  await c.query(
    `INSERT INTO event
       (tenant_id, aggregate_type, aggregate_id, kind, payload, actor_type)
     VALUES ($1, 'rental_order', $2, 'agreement.signed', $3, 'customer')`,
    [opts.tenantId, opts.orderId,
     JSON.stringify({ version: offer.version, channel: opts.channel ?? 'telegram' })],
  )

  return { version: offer.version, signedAt: rows[0]!.signed_at }
}
