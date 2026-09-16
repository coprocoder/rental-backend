/**
 * Тестовое окружение: настоящий Postgres, отдельная база.
 *
 * Каждый тест выполняется в транзакции, которая откатывается —
 * так тесты не видят друг друга и не требуют очистки.
 */
import { afterAll, beforeAll } from 'vitest'
import { Pool } from 'pg'

/**
 * Пул создаётся в beforeAll, поэтому наружу отдаётся функция, а не
 * переменная: экспортированный `let` позволяет прочитать undefined
 * до инициализации, и падение выглядит как ошибка драйвера.
 */
/**
 * ⚠️ `createError` — автоимпорт Nitro, в vitest его нет. Без него любая
 * ветка через `apiError` падает с «createError is not defined», то есть
 * тест на ОТКАЗ проверяет отсутствие функции, а не поведение кода.
 * Из-за этого ошибочные пути домена оставались непокрытыми.
 *
 * Подставляется настоящая форма ошибки h3 — statusCode, message и data
 * с кодом внутри: домен кладёт туда причину, а обработчики и клиент
 * её оттуда читают.
 */
;(globalThis as Record<string, unknown>).createError ??= (
  opts: { statusCode?: number, message?: string, data?: unknown },
) => Object.assign(new Error(opts.message ?? 'Ошибка'), {
  statusCode: opts.statusCode ?? 500,
  data: opts.data,
})

let poolRef: Pool | null = null

export function pool(): Pool {
  if (!poolRef) throw new Error('Пул ещё не создан: обращение до beforeAll')
  return poolRef
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL_TEST не задан')
  poolRef = new Pool({ connectionString: url })
  // Проверяем связь сразу: иначе первый упавший тест будет непонятным.
  await poolRef.query('SELECT 1')
})

afterAll(async () => {
  await poolRef?.end()
  poolRef = null
})

/**
 * Выполняет тело в транзакции и откатывает её.
 * Использование: await inRollback(async (c) => { ... })
 */
export async function inRollback<T>(
  fn: (client: import('pg').PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool().connect()
  try {
    await client.query('BEGIN')
    return await fn(client)
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
}
