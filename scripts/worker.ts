/**
 * Фоновый процесс: обработчик outbox и снятие просроченных броней.
 *
 * Запуск: npm run worker
 *
 * ⚠️ Отдельный процесс, а не таймер внутри Nuxt. Причины:
 *   при нескольких экземплярах приложения таймер запустится в каждом,
 *   и одна бронь будет сниматься несколько раз;
 *   перезапуск веб-процесса не должен прерывать доставку;
 *   воркер ходит под ролью с BYPASSRLS, а веб — под ролью с RLS.
 *
 * ⚠️ Планировщик самодельный, а не BullMQ repeatable jobs: задачи здесь
 * идемпотентны и дёшевы, состояние живёт в Postgres, а не в Redis.
 *
 * ⚠️ BullMQ НЕ подключён — ни зависимости, ни кода (TODO 17.28). Раньше
 * здесь было написано «подключён для будущих очередей», и это читалось
 * как «уже работает». Он рассматривается на будущее, для очередей
 * уведомлений с приоритетами и раздельными ретраями по каналам, но
 * источником правды и тогда останется таблица outbox: Redis не
 * участвует в транзакции Postgres.
 */
import { registerNotificationHandlers } from '~/integrations/notify'
import { expireHolds, expireUnconfirmed, markOverdue } from '~/domain/orders/expire'
import { processOutboxBatch } from '~/domain/core/outbox'
import { remindUnconfirmed } from '~/domain/platform/reminders'
import { expireWaitlist, passExpiredOffers } from '~/domain/availability/waitlist'
import { anonymizeExpired } from '~/domain/admin/privacy'
import { createLogger } from '~/kernel/logger'
import { loadConfig } from '~/kernel/config'
import { getWorkerPool } from '~/kernel/db'

/**
 * ⚠️ Логгер СОЗДАЁТСЯ здесь, как в `main.ts`, а не импортируется
 * готовым: `kernel/logger` экспортирует только фабрику `createLogger`,
 * и `import { logger }` не существовал никогда.
 *
 * ⚠️ Из-за этого воркер НЕ ЗАПУСКАЛСЯ вовсе — ни в разработке, ни в
 * проде: `SyntaxError: does not provide an export named 'logger'`.
 * А он рассылает уведомления и снимает просроченные брони. Поймать это
 * было нечем: `tsc --noEmit` проверяет только `src/**`, а `scripts/`
 * в сборку не входили, и первый же запуск был бы на стенде.
 */
const logger = createLogger(loadConfig())

/** Как часто крутится цикл. Секунды, не минуты: outbox должен быть быстрым. */
const TICK_MS = 15_000

/**
 * Реже, чем outbox: дедлайн — сутки, и проверять его каждые 15 секунд
 * незачем. Раз в минуту достаточно, а нагрузка на БД меньше.
 */
const EXPIRE_EVERY_TICKS = 4

let stopping = false

const log = (msg: string, extra?: Record<string, unknown>): void => {
  // Ошибки — уровнем error: сборщик логов (16.5) поднимет их в алерт,
  // а «снято 3 брони» останется info.
  if (extra && 'error' in extra) logger.error(extra, msg)
  else logger.info(extra ?? {}, msg)
}

async function tick(n: number): Promise<void> {
  // Outbox — каждый тик.
  try {
    const r = await processOutboxBatch()
    if (r.done || r.failed || r.dead) log('outbox', r)
  } catch (err) {
    log('outbox упал', { error: err instanceof Error ? err.message : String(err) })
  }

  if (n % EXPIRE_EVERY_TICKS !== 0) return

  // Снятие неподтверждённых броней — главный механизм защиты инвентаря.
  try {
    const r = await expireUnconfirmed()
    if (r.expired) log('сняты неподтверждённые брони', { count: r.expired, codes: r.codes })
  } catch (err) {
    log('снятие броней упало', { error: err instanceof Error ? err.message : String(err) })
  }

  try {
    const n2 = await markOverdue()
    if (n2) log('помечены просроченные возвраты', { count: n2 })
  } catch (err) {
    log('overdue упал', { error: err instanceof Error ? err.message : String(err) })
  }

  try {
    const n3 = await expireHolds()
    if (n3) log('освобождены корзины', { count: n3 })
  } catch (err) {
    log('holds упал', { error: err instanceof Error ? err.message : String(err) })
  }

  // Напоминания подтвердить бронь: за 48 и за 12 часов до дедлайна.
  // ⚠️ После expireUnconfirmed, а не до: незачем напоминать о броне,
  // которую этот же тик только что снял.
  try {
    const n4 = await tickReminders()
    if (n4) log('поставлены напоминания', { count: n4 })
  } catch (err) {
    log('напоминания упали', { error: err instanceof Error ? err.message : String(err) })
  }

  // Обезличивание просроченных ПД — обязанность по 152-ФЗ, и она
  // не может зависеть от того, зашёл ли кто-то в админку.
  try {
    const n = await tickPrivacy()
    if (n) log('обезличены просроченные записи', { count: n })
  } catch (err) {
    log('обезличивание упало', { error: err instanceof Error ? err.message : String(err) })
  }

  // Лист ожидания: передать предложение следующему, если предыдущий
  // не отреагировал за отведённое окно, и истечь записи, у которых
  // желаемый интервал уже начался.
  try {
    const r = await tickWaitlist()
    if (r.passed || r.expired) log('лист ожидания', r)
  } catch (err) {
    log('лист ожидания упал', { error: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * Напоминания подтвердить бронь.
 *
 * ⚠️ Под ролью воркера (BYPASSRLS), то есть по всем тенантам сразу —
 * tenantId не передаётся намеренно. От повторной отправки защищает
 * не этот проход, а уникальный ключ идемпотентности в outbox.
 */
async function tickReminders(): Promise<number> {
  const client = await getWorkerPool().connect()
  try {
    await client.query('BEGIN')
    const n = await remindUnconfirmed(client)
    await client.query('COMMIT')
    return n
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

/**
 * Обход листа ожидания.
 *
 * ⚠️ Идёт под ролью воркера (BYPASSRLS): записи всех тенантов в одной
 * очереди, как и outbox.
 */
async function tickPrivacy(): Promise<number> {
  const client = await getWorkerPool().connect()
  try {
    await client.query('BEGIN')
    const { anonymized } = await anonymizeExpired(client)
    await client.query('COMMIT')
    return anonymized
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

async function tickWaitlist(): Promise<{ passed: number, expired: number }> {
  const client = await getWorkerPool().connect()
  try {
    await client.query('BEGIN')
    const passed = await passExpiredOffers(client)
    const expired = await expireWaitlist(client)
    await client.query('COMMIT')
    return { passed, expired }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

async function main(): Promise<void> {
  registerNotificationHandlers()
  log('запущен', { tickMs: TICK_MS })

  let n = 0
  while (!stopping) {
    n++
    await tick(n)
    // Пауза дробится, чтобы остановка была быстрой.
    for (let i = 0; i < TICK_MS / 500 && !stopping; i++) {
      await new Promise((r) => setTimeout(r, 500))
    }
  }

  log('остановлен')
  process.exit(0)
}

// ⚠️ Корректная остановка: недоделанная задача останется pending и
// будет взята следующим запуском — потому что состояние в Postgres,
// а не в памяти процесса.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log(`получен ${sig}, останавливаюсь`)
    stopping = true
  })
}

main().catch((err) => {
  logger.fatal({ err }, 'воркер не запустился')
  process.exit(1)
})
