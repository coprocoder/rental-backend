/**
 * Обработчик outbox — внешние эффекты, записанные в транзакции.
 *
 * Зачем паттерн (../rental-docs/docs/04-тз/10-бэкенд/21-события-и-надёжность.md): уведомление
 * нельзя отправлять из обработчика запроса. Упавший шлюз уронил бы
 * оформление заказа, а отправка «на всякий случай» до COMMIT рассылает
 * письма про заказы, которых не существует.
 *
 * ⚠️ Redis НЕ заменяет outbox: он не участвует в транзакции Postgres.
 * Запись в очередь после COMMIT может не произойти (упал процесс), и
 * уведомление потеряется молча. Поэтому источник правды — таблица,
 * а Redis только ускоряет доставку.
 *
 * Гарантия — «хотя бы один раз», значит обработчики ОБЯЗАНЫ быть
 * идемпотентными: одно и то же письмо может прийти дважды.
 */
import type { PoolClient } from 'pg'
import { getWorkerPool } from '~/kernel/db'

export interface OutboxRow {
  id: string
  tenant_id: string
  kind: string
  payload: Record<string, unknown>
  attempts: number
}

/** Обработчик одного вида эффекта. Должен быть идемпотентным. */
export type OutboxHandler = (row: OutboxRow) => Promise<void>

const handlers = new Map<string, OutboxHandler>()

export function registerHandler(kind: string, fn: OutboxHandler): void {
  handlers.set(kind, fn)
}

/** Сколько раз пробуем, прежде чем отправить в мёртвую очередь. */
const MAX_ATTEMPTS = 6

/**
 * Задержка перед следующей попыткой — возрастающая.
 *
 * ⚠️ Без возрастающей задержки упавший внешний сервис получает шторм
 * повторов и не успевает подняться. 1 мин → 2 → 4 → 8 → 16 → 32.
 */
export function backoffMinutes(attempts: number): number {
  return Math.min(2 ** attempts, 60)
}

/**
 * Забирает пачку задач и выполняет их.
 *
 * ⚠️ FOR UPDATE SKIP LOCKED: несколько воркеров не берут одну задачу.
 * Без SKIP LOCKED второй воркер ждёт первого, и параллельность мнимая.
 */
export async function processOutboxBatch(limit = 20): Promise<{
  done: number
  failed: number
  dead: number
}> {
  const pool = getWorkerPool()
  const client = await pool.connect()
  let done = 0
  let failed = 0
  let dead = 0

  try {
    await client.query('BEGIN')

    // ⚠️ Идёт под ролью rental_worker (BYPASSRLS): обработчик обязан
    // видеть строки всех тенантов — очередь одна на всех. tenant_id
    // берётся из самой строки и передаётся обработчику.
    const { rows } = await client.query<OutboxRow & { next_attempt_at: Date }>(
      `SELECT id, tenant_id, kind, payload, attempts
       FROM outbox
       WHERE status = 'pending'
         AND next_attempt_at <= now()
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT $1`,
      [limit],
    )

    for (const row of rows) {
      const handler = handlers.get(row.kind)

      if (!handler) {
        // Неизвестный вид — не ошибка доставки, а пробел в коде.
        // Отправляем в мёртвую очередь сразу: повторы не помогут.
        await client.query(
          `UPDATE outbox SET status = 'dead', last_error = $2 WHERE id = $1`,
          [row.id, `нет обработчика для вида «${row.kind}»`],
        )
        dead++
        continue
      }

      try {
        await handler(row)
        await client.query(
          `UPDATE outbox SET status = 'sent', sent_at = now() WHERE id = $1`,
          [row.id],
        )
        done++
      } catch (err) {
        const attempts = row.attempts + 1
        const message = err instanceof Error ? err.message : String(err)

        if (attempts >= MAX_ATTEMPTS) {
          // Мёртвая очередь: дальше разбирается человек.
          await client.query(
            `UPDATE outbox
             SET status = 'dead', attempts = $2, last_error = $3
             WHERE id = $1`,
            [row.id, attempts, message],
          )
          dead++
        } else {
          await client.query(
            `UPDATE outbox
             SET attempts = $2,
                 last_error = $3,
                 next_attempt_at = now() + ($4 || ' minutes')::interval
             WHERE id = $1`,
            [row.id, attempts, message, backoffMinutes(attempts)],
          )
          failed++
        }
      }
    }

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }

  return { done, failed, dead }
}

/** Помещает эффект в outbox. Вызывается ВНУТРИ транзакции состояния. */
export async function enqueue(
  c: PoolClient,
  opts: {
    tenantId: string
    kind: string
    payload: Record<string, unknown>
    /**
     * Ключ идемпотентности — ОБЯЗАТЕЛЕН: колонка NOT NULL и уникальна
     * в пределах тенанта. Без ключа повторная запись того же эффекта
     * создала бы второе письмо о том же заказе.
     */
    idempotencyKey: string
    correlationId?: string
  },
): Promise<void> {
  await c.query(
    `INSERT INTO outbox (tenant_id, kind, payload, idempotency_key, correlation_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
    [
      opts.tenantId,
      opts.kind,
      JSON.stringify(opts.payload),
      opts.idempotencyKey,
      opts.correlationId ?? null,
    ],
  )
}
