/**
 * Уведомления клиенту: Telegram/MAX → email.
 *
 * ⚠️ SMS в MVP нет вовсе (../rental-docs/docs/04-тз/10-бэкенд/16-уведомления.md): помимо цены
 * за сообщение есть абонентская плата за буквенное имя отправителя —
 * порядка 2–3 тыс. ₽/мес на каждого оператора, то есть около 10 тыс. ₽
 * до первого отправленного сообщения. Для запуска неоправданно.
 *
 * ⚠️ Уведомления — несущий элемент защиты инвентаря, а не удобство:
 * без работающего напоминания механизм подтверждения броней не
 * работает, и арсенал блокируется неподтверждёнными бронями.
 *
 * ⚠️ Порядок деградации: если чат мессенджера не связан, канала
 * мессенджера НЕТ, и сообщение идёт на email. Механизм подтверждения
 * не должен зависеть от того, подключил ли клиент Telegram.
 *
 * Все обработчики идемпотентны: доставка «хотя бы один раз» означает,
 * что одно и то же сообщение может прийти дважды.
 */
import { createConnection } from 'node:net'
import type { OutboxRow } from '../domain/core/outbox'
import { registerHandler } from '../domain/core/outbox'
import { getWorkerPool } from '~/kernel/db'
import { renderTemplate, type TemplateKey } from './notify.i18n'

export type Channel = 'telegram' | 'max' | 'email'

export interface Recipient {
  phone: string
  email: string | null
  messenger: 'telegram' | 'max' | null
  messengerChatId: string | null
  name: string | null
  locale: string
}

/**
 * Куда отправлять.
 *
 * ⚠️ Мессенджер только если чат РЕАЛЬНО связан: наличие поля
 * `messenger` без `chat_id` означает «клиент собирался», а не «можно
 * писать».
 */
export function pickChannel(r: Recipient): Channel | null {
  if (r.messenger && r.messengerChatId) return r.messenger
  if (r.email) return 'email'
  // Ни мессенджера, ни почты: в MVP отправить нечем — SMS нет.
  return null
}

/** Данные получателя по заказу. */
async function recipientForOrder(orderId: string): Promise<Recipient | null> {
  const { rows } = await getWorkerPool().query<{
    phone: string
    email: string | null
    messenger: 'telegram' | 'max' | null
    messenger_chat_id: string | null
    name: string | null
    locale: string
  }>(
    `SELECT cu.phone, cu.email, cu.messenger, cu.messenger_chat_id, cu.name,
            t.locale
     FROM rental_order o
     JOIN customer cu ON cu.id = o.customer_id
     JOIN tenant t ON t.id = o.tenant_id
     WHERE o.id = $1`,
    [orderId],
  )
  const r = rows[0]
  if (!r) return null

  return {
    phone: r.phone,
    email: r.email,
    messenger: r.messenger,
    messengerChatId: r.messenger_chat_id,
    name: r.name,
    locale: r.locale,
  }
}

/**
 * Отправка письма минимальным SMTP-диалогом.
 *
 * ⚠️ Своя реализация вместо nodemailer намеренно: локально нужен только
 * Mailpit без аутентификации и TLS, а в проде отправка пойдёт через
 * адаптер провайдера. Тянуть зависимость ради четырёх команд SMTP,
 * которые всё равно будут заменены, незачем.
 */
async function sendMail(opts: {
  to: string
  subject: string
  text: string
}): Promise<void> {
  const host = process.env.SMTP_HOST ?? 'localhost'
  const port = Number(process.env.SMTP_PORT ?? 1025)
  const from = process.env.SMTP_FROM ?? 'noreply@rental.local'

  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host, port })
    const script = [
      `EHLO rental`,
      `MAIL FROM:<${from}>`,
      `RCPT TO:<${opts.to}>`,
      `DATA`,
      // Заголовки в UTF-8: без charset русский текст приходит битым.
      [
        `From: ${from}`,
        `To: ${opts.to}`,
        `Subject: =?UTF-8?B?${Buffer.from(opts.subject).toString('base64')}?=`,
        `MIME-Version: 1.0`,
        `Content-Type: text/plain; charset=UTF-8`,
        `Content-Transfer-Encoding: base64`,
        ``,
        Buffer.from(opts.text).toString('base64'),
        `.`,
      ].join('\r\n'),
      `QUIT`,
    ]
    let step = -1

    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`SMTP ${host}:${port} не ответил`))
    }, 10_000)

    socket.on('data', () => {
      step++
      if (step < script.length) {
        socket.write(script[step] + '\r\n')
      } else {
        clearTimeout(timer)
        socket.end()
        resolve()
      }
    })
    socket.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

/**
 * Отправка в Telegram.
 *
 * ⚠️ Бот принадлежит ТЕНАНТУ, а не платформе: клиент общается с
 * прокатом, у которого арендует. Токен — такая же интеграционная
 * настройка тенанта, как ключи эквайринга.
 *
 * Без настроенного токена бросаем ошибку, а не молча пропускаем:
 * непойманное «уведомление не ушло» ломает защиту инвентаря, и лучше
 * увидеть это в мёртвой очереди.
 */
async function sendTelegram(opts: {
  tenantId: string
  chatId: string
  text: string
}): Promise<void> {
  const { rows } = await getWorkerPool().query<{ token: string | null }>(
    `SELECT (theme->'integrations'->>'telegramBotToken') AS token
     FROM tenant WHERE id = $1`,
    [opts.tenantId],
  )
  const token = rows[0]?.token ?? process.env.TELEGRAM_BOT_TOKEN

  if (!token) {
    throw new Error('токен Telegram-бота тенанта не настроен')
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: opts.chatId, text: opts.text }),
  })
  if (!res.ok) {
    throw new Error(`Telegram ответил ${res.status}`)
  }
}

/**
 * Отправка в MAX (8.4).
 *
 * ⚠️ MAX поддерживает deep-link со start-payload — это подтверждено
 * официальной документацией (dev.max.ru), и запасной путь со связкой
 * коротким кодом не понадобился. Формат ссылки `https://max.ru/{bot}
 * ?start={payload}`, payload до 128 символов, приходит в обновлении
 * `bot_started` полем `payload`. Наш view-токен — 43 символа base64url,
 * укладывается с запасом.
 *
 * ⚠️ Токен передаётся ЗАГОЛОВКОМ Authorization, а не query-параметром:
 * передача через query официально больше не поддерживается, и ключ
 * в адресе всё равно оседал бы в логах прокси.
 *
 * ⚠️ Бот принадлежит ТЕНАНТУ, как и в Telegram: клиент общается
 * с прокатом, у которого арендует, а не с платформой.
 */
async function sendMax(opts: {
  tenantId: string
  chatId: string
  text: string
}): Promise<void> {
  const { rows } = await getWorkerPool().query<{ token: string | null }>(
    `SELECT (theme->'integrations'->>'maxBotToken') AS token
     FROM tenant WHERE id = $1`,
    [opts.tenantId],
  )
  const token = rows[0]?.token ?? process.env.MAX_BOT_TOKEN

  if (!token) {
    throw new Error('токен MAX-бота тенанта не настроен')
  }

  const res = await fetch('https://platform-api2.max.ru/messages', {
    method: 'POST',
    headers: {
      'authorization': token,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ chat_id: opts.chatId, text: opts.text }),
  })
  if (!res.ok) {
    throw new Error(`MAX ответил ${res.status}`)
  }
}

/** Отправка через выбранный канал. */
async function deliver(opts: {
  tenantId: string
  recipient: Recipient
  key: TemplateKey
  vars: Record<string, string>
}): Promise<Channel> {
  const channel = pickChannel(opts.recipient)
  if (!channel) {
    throw new Error('нет доступного канала: ни мессенджера, ни email')
  }

  const { subject, text } = renderTemplate(opts.key, opts.recipient.locale, opts.vars)

  if (channel === 'email') {
    await sendMail({ to: opts.recipient.email!, subject, text })
    return channel
  }

  // Мессенджер — с ДЕГРАДАЦИЕЙ на email (../rental-docs/docs/04-тз/10-бэкенд/16-уведомления.md):
  // если бот тенанта не настроен или Telegram ответил ошибкой, а почта
  // есть — письмо уходит сразу, а не после шести ретраев в мёртвую
  // очередь. ⚠️ Найдено вживую: клиент связал чат через /start, бот у
  // тенанта без токена, и ссылка подтверждения зависла в pending —
  // то есть механизм защиты инвентаря молча не работал.
  try {
    if (channel === 'telegram') {
      await sendTelegram({
        tenantId: opts.tenantId,
        chatId: opts.recipient.messengerChatId!,
        text: `${subject}\n\n${text}`,
      })
    } else {
      await sendMax({
        tenantId: opts.tenantId,
        chatId: opts.recipient.messengerChatId!,
        text: `${subject}\n\n${text}`,
      })
    }
    return channel
  } catch (err) {
    if (!opts.recipient.email) throw err
    await sendMail({ to: opts.recipient.email, subject, text })
    return 'email'
  }
}

/**
 * Deep-link на бота тенанта с токеном заказа в payload.
 *
 * Пусто, если бот у тенанта не настроен: строка в письме тогда не
 * появляется вовсе, а не выглядит битой ссылкой.
 */
async function telegramDeepLink(tenantId: string, viewToken?: string): Promise<string> {
  if (!viewToken) return ''

  const { rows } = await getWorkerPool().query<{
    tg: string | null
    max: string | null
  }>(
    `SELECT theme->'integrations'->>'telegramBotUsername' AS tg,
            theme->'integrations'->>'maxBotUsername'      AS max
     FROM tenant WHERE id = $1`,
    [tenantId],
  )
  const r = rows[0]

  const lines: string[] = []

  // Telegram ограничивает payload 64 символами [A-Za-z0-9_-]; base64url
  // токена 43 символа — укладывается.
  if (r?.tg) {
    lines.push(`Получать напоминания в Telegram: https://t.me/${r.tg}?start=${viewToken}`)
  }

  // ⚠️ MAX: payload до 128 символов, тот же формат ?start=. Проверено
  // по официальной документации (dev.max.ru) — запасной механизм
  // со связкой коротким кодом не понадобился.
  if (r?.max) {
    lines.push(`Получать напоминания в MAX: https://max.ru/${r.max}?start=${viewToken}`)
  }

  return lines.join('\n')
}

/** База сайта для ссылок в письмах. */
function baseUrl(): string {
  return process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000'
}

/**
 * Регистрирует обработчики видов outbox.
 *
 * ⚠️ Вызывается воркером при старте. Неизвестный вид уходит в мёртвую
 * очередь сразу — это пробел в коде, а не сбой доставки.
 */
export function registerNotificationHandlers(): void {
  // Ссылка подтверждения — несущий элемент защиты инвентаря.
  registerHandler('order.confirm_link', async (row: OutboxRow) => {
    const orderId = String(row.payload.orderId)
    const recipient = await recipientForOrder(orderId)
    if (!recipient) throw new Error('получатель не найден')

    const tokens = row.payload.tokens as Record<string, string> | undefined
    const code = String(row.payload.code ?? '')

    await deliver({
      tenantId: row.tenant_id,
      recipient,
      key: row.payload.needsOperator ? 'order_created_group' : 'order_created',
      vars: {
        name: recipient.name ?? '',
        code,
        confirmUrl: tokens?.confirm ? `${baseUrl()}/o/${tokens.confirm}/confirm` : '',
        viewUrl: tokens?.view ? `${baseUrl()}/o/${tokens.view}` : '',
        cancelUrl: tokens?.cancel ? `${baseUrl()}/o/${tokens.cancel}/cancel` : '',
        // ⚠️ Связывание с Telegram — ПОСЛЕ оформления, а не шагом формы:
        // шаг в форме уводит из виджета до создания заказа и режет
        // конверсию. После оформления мотивация подключиться максимальна:
        // там придут напоминание и ссылка подтверждения.
        // Payload /start — view-токен: бот находит заказ по нему и
        // сохраняет chat_id у клиента. Бот принадлежит ТЕНАНТУ.
        telegramLine: await telegramDeepLink(row.tenant_id, tokens?.view),
      },
    })
  })

  // Напоминание подтвердить: за 48 и 12 часов до начала.
  registerHandler('order.confirm_reminder', async (row: OutboxRow) => {
    const orderId = String(row.payload.orderId)
    const recipient = await recipientForOrder(orderId)
    if (!recipient) throw new Error('получатель не найден')

    await deliver({
      tenantId: row.tenant_id,
      recipient,
      key: 'confirm_reminder',
      vars: {
        code: String(row.payload.code ?? ''),
        deadline: String(row.payload.deadline ?? ''),
        // ⚠️ Токен выписан заново на момент напоминания: тот, что ушёл
        // при оформлении, в базе лежит только хешем и восстановлению
        // не подлежит. Ссылку собираем здесь — как для order.created.
        confirmUrl: row.payload.confirmToken
          ? `${baseUrl()}/o/${String(row.payload.confirmToken)}/confirm`
          : '',
      },
    })
  })

  registerHandler('order.expired', async (row: OutboxRow) => {
    const orderId = String(row.payload.orderId)
    const recipient = await recipientForOrder(orderId)
    if (!recipient) throw new Error('получатель не найден')

    await deliver({
      tenantId: row.tenant_id,
      recipient,
      key: 'order_expired',
      vars: { code: String(row.payload.code ?? '') },
    })
  })

  registerHandler('order.confirmed', async (row: OutboxRow) => {
    const orderId = String(row.payload.orderId)
    const recipient = await recipientForOrder(orderId)
    if (!recipient) throw new Error('получатель не найден')

    await deliver({
      tenantId: row.tenant_id,
      recipient,
      key: 'order_confirmed',
      vars: { code: String(row.payload.code ?? '') },
    })
  })

  // Код ПЭП для подписания договора.
  registerHandler('agreement.sign_code', async (row: OutboxRow) => {
    const recipient = await recipientForOrder(String(row.payload.orderId))
    if (!recipient) throw new Error('получатель не найден')

    await deliver({
      tenantId: row.tenant_id,
      recipient,
      key: 'sign_code',
      vars: {
        code: String(row.payload.code ?? ''),
        minutes: '15',
      },
    })
  })

  // Лист ожидания: освободился инвентарь.
  registerHandler('waitlist.available', async (row: OutboxRow) => {
    // ⚠️ Контакт берётся из customer по customer_id: в waitlist своих
    // полей телефона и почты нет — запись ссылается на клиента, чтобы
    // контакт не расходился между таблицами.
    const { rows } = await getWorkerPool().query<{
      phone: string
      email: string | null
      messenger: 'telegram' | 'max' | null
      messenger_chat_id: string | null
      name: string | null
      locale: string
      slug: string
    }>(
      `SELECT cu.phone, cu.email, cu.messenger, cu.messenger_chat_id, cu.name,
              t.locale, t.slug
       FROM waitlist w
       JOIN customer cu ON cu.id = w.customer_id
       JOIN tenant t ON t.id = w.tenant_id
       WHERE w.id = $1`,
      [String(row.payload.waitlistId)],
    )
    const r = rows[0]
    if (!r) throw new Error('запись листа ожидания не найдена')

    await deliver({
      tenantId: row.tenant_id,
      recipient: {
        phone: r.phone,
        email: r.email,
        messenger: r.messenger,
        messengerChatId: r.messenger_chat_id,
        name: r.name,
        locale: r.locale,
      },
      key: 'waitlist_available',
      vars: {
        variant: String(row.payload.variantName ?? ''),
        bookUrl: `${baseUrl()}/r/${r.slug}`,
        minutes: String(row.payload.reactionMinutes ?? '45'),
      },
    })
  })
}
