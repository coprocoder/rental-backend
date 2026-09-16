/**
 * Пул соединений и выполнение работы в контексте тенанта.
 *
 * ⚠️ tenant_id выставляется через SET LOCAL, а не подставляется в WHERE
 * прикладным кодом: RLS в БД не даст ошибиться, если запрос забудут
 * отфильтровать. И SET LOCAL, а не SET — сбрасывается по завершении
 * транзакции и не протекает между запросами в пуле.
 *
 * ⚠️ Отличие от `../rental/server/utils/db.ts`: там пять экспортов, из
 * которых три (`query`, `queryNoTenant`, `withTenant`) открывают КАЖДЫЙ
 * свою транзакцию. Это уже дало дефект — каталог читал шестью отдельными
 * снимками данных, между которыми склад мог измениться (`plans/02-СЛОИ.md`).
 * Здесь транзакцию открывает только usecase, ровно один раз на сценарий,
 * а domain и gateway получают готовый PoolClient.
 */
import { Pool, type PoolClient } from 'pg'

export type { PoolClient }

/**
 * Что usecase получает для работы с БД.
 *
 * ⚠️ Интерфейс, а не сам Pool: usecase принимает его параметром `deps`
 * (инверсия зависимостей, `plans/02-СЛОИ.md`), и в тесте сюда
 * подставляется транзакция с откатом. Без этого каждый сценарный тест
 * оставлял бы за собой строки в базе.
 */
export interface Db {
  /** Транзакция в контексте тенанта. Основной способ работы. */
  tx<T>(tenantId: string, fn: (c: PoolClient) => Promise<T>): Promise<T>
  /**
   * Транзакция БЕЗ тенантного контекста.
   *
   * ⚠️ Единственный законный случай — поиск заказа по токену клиента:
   * тенант определяется самим токеном, поэтому до его разбора выставить
   * app.tenant_id нечем. Возвращать отсюда данные заказа нельзя: только
   * tenant_id и order_id, после чего работа продолжается в `tx`.
   */
  txAnonymous<T>(fn: (c: PoolClient) => Promise<T>): Promise<T>
  /**
   * Разовое чтение вне тенантного контекста.
   *
   * ⚠️ ТОЛЬКО для таблиц без RLS — на практике это `tenant`, по которому
   * слаг витрины превращается в tenant_id.
   *
   * ⚠️ Так было не всегда, и это стоило неработающей витрины. Каталог
   * читал через эту функцию ВСЕ свои таблицы. На машине разработчика
   * приложение ходит под владельцем БД, для которого RLS не применяется,
   * и всё работало. В проде роль другая — rental_app с RLS, — и те же
   * запросы возвращали ноль строк: витрина показывала «Прокат не найден»
   * при полной базе. То есть разница между dev и прод была не в коде,
   * а в РОЛИ, и поймать её можно было только запуском под rental_app.
   */
  unscoped<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
  /** Закрывает пул. Нужно для корректного завершения процесса. */
  close(): Promise<void>
}

function makePool(url: string, max: number): Pool {
  return new Pool({ connectionString: url, max })
}

/**
 * Пул приложения: роль без BYPASSRLS, изоляция тенантов работает.
 *
 * ⚠️ `max` умножается на число реплик. Три реплики по 10 — уже 30
 * соединений при дефолтных 100 в Postgres, и это причина для PgBouncer,
 * а не для увеличения max_connections (`plans/05-НАГРУЗКА.md`).
 */
export function createDb(opts: { url: string, max?: number } ): Db {
  const pool = makePool(opts.url, opts.max ?? 10)

  async function inTransaction<T>(
    tenantId: string | null,
    fn: (c: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      if (tenantId !== null) {
        // ⚠️ set_config(..., true) — это и есть SET LOCAL: действует до
        // конца транзакции. Параметризованный вызов, а не склейка строки:
        // tenantId приходит из сессии, но правило «только плейсхолдеры»
        // не знает исключений.
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId])
      }
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  return {
    tx: (tenantId, fn) => inTransaction(tenantId, fn),
    txAnonymous: (fn) => inTransaction(null, fn),
    async unscoped<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
      const { rows } = await pool.query<T>(sql, params)
      return rows
    },
    close: () => pool.end(),
  }
}

/**
 * Пул для ФОНОВЫХ процессов: обработчик outbox, автоснятие броней.
 *
 * ⚠️ Отдельная роль rental_worker с BYPASSRLS, потому что воркеры
 * работают поперёк тенантов по определению: очередь одна на всех,
 * просроченные брони тоже. Веб-приложение под этой ролью НЕ ходит —
 * иначе RLS перестала бы защищать, и вся конструкция «инварианты
 * в БД, а не в коде» потеряла бы смысл.
 */
export function createWorkerDb(opts: { url: string, max?: number }): Db {
  return createDb({ url: opts.url, max: opts.max ?? 4 })
}

let workerPool: Pool | undefined

/**
 * Пул воркера как синглтон.
 *
 * ⚠️ Нужен потому, что домен переехал из Nuxt как есть, а там фоновые
 * функции берут пул сами (`getWorkerPool`), а не получают его
 * параметром. Переписывать 10 200 строк домена ради инверсии
 * зависимостей — работа, которая ничего не чинит и рискует поведением;
 * это прямо запрещено планом переезда.
 *
 * ⚠️ Отдельная роль `rental_worker` с BYPASSRLS: воркеры работают
 * поперёк тенантов по определению — очередь одна на всех, просроченные
 * брони тоже. Веб-приложение под этой ролью НЕ ходит, иначе RLS
 * перестала бы защищать.
 */
export function getWorkerPool(): Pool {
  if (!workerPool) {
    const url = process.env.DATABASE_URL_WORKER ?? process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL не задан')
    workerPool = makePool(url, 4)
  }
  return workerPool
}
