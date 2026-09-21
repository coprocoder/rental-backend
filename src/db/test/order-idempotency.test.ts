/**
 * Идемпотентность создания заказа — инвариантом БД, а не кодом.
 *
 * ⚠️ Железное правило 2: инварианты живут в базе. Проверка на уровне
 * приложения («прочитал — не нашёл — вставил») НЕ закрывает гонку:
 * между SELECT и INSERT второй запрос успевает пройти ту же проверку,
 * и оба вставляют заказ с одним `Idempotency-Key`.
 *
 * ⚠️ Почему это не теоретический риск. Клиент нажимает «Забронировать»
 * дважды — на медленной связи это обычное дело, а виджет ретраит сам.
 * Итог: два заказа, два удержания инвентаря, и снаряжение снято со
 * склада в двойном объёме. Разбирать это придётся человеку на стойке.
 *
 * ⚠️ Гонка воспроизводится на РАЗНЫХ соединениях: на одном соединении
 * запросы идут последовательно, и никакой гонки нет — тест прошёл бы
 * и на сломанном коде.
 */
import { describe, expect, it } from 'vitest'
import { inRollback, pool } from './setup'

const DAY = 86_400_000

interface Fixture { tenantId: string, branchId: string, customerId: string }

async function fixture(c: import('pg').PoolClient): Promise<Fixture> {
  const { rows: [t] } = await c.query<{ id: string }>(
    `INSERT INTO tenant (slug, name) VALUES ($1, 'Идемпотентность') RETURNING id`,
    [`idem-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`],
  )
  const tenantId = t!.id
  await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId])

  const { rows: [b] } = await c.query<{ id: string }>(
    `INSERT INTO branch (tenant_id, name, timezone)
     VALUES ($1, 'Филиал', 'Asia/Krasnoyarsk') RETURNING id`, [tenantId],
  )
  // ⚠️ Вариант и категория здесь НЕ нужны: проверяется уникальность
  // ключа на самом заказе, а не его состав. Лишняя фикстура — лишний
  // повод для теста упасть не по своей причине.
  const { rows: [cu] } = await c.query<{ id: string }>(
    `INSERT INTO customer (tenant_id, name, phone)
     VALUES ($1, 'Клиент', '+79990000001') RETURNING id`, [tenantId],
  )
  return { tenantId, branchId: b!.id, customerId: cu!.id }
}

/**
 * Вставка заказа так же, как это делает `create-order.public.ts`:
 * ключ идемпотентности лежит внутри `price_breakdown`.
 */
async function insertOrder(
  c: import('pg').PoolClient, f: Fixture, code: string, idemKey: string,
): Promise<void> {
  const from = new Date(Date.now() + 3 * DAY)
  const to = new Date(Date.now() + 5 * DAY)
  await c.query(
    `INSERT INTO rental_order
       (tenant_id, public_code, branch_pickup_id, customer_id, status, period,
        confirm_deadline, total_amount, price_breakdown, retention_until)
     VALUES ($1, $2, $3, $4, 'awaiting_confirm', tstzrange($5, $6),
             now() + interval '1 day', '1000.00', $7, now() + interval '3 years')`,
    [f.tenantId, code, f.branchId, f.customerId, from, to,
     JSON.stringify({ total: '1000.00', idemKey })],
  )
}

/**
 * Уборка за тестом гонки.
 *
 * ⚠️ Обязательна: его данные вставлены ВНЕ откатываемой транзакции и
 * сами не исчезнут. Порядок — от листьев к корню: каскадного удаления
 * тенанта нет намеренно.
 */
async function cleanup(tenantId: string): Promise<void> {
  const c = await pool().connect()
  try {
    await c.query(`DELETE FROM rental_order WHERE tenant_id = $1`, [tenantId])
    await c.query(`DELETE FROM customer WHERE tenant_id = $1`, [tenantId])
    await c.query(`DELETE FROM branch WHERE tenant_id = $1`, [tenantId])
    await c.query(`DELETE FROM tenant WHERE id = $1`, [tenantId])
  } finally {
    c.release()
  }
}

describe('идемпотентность заказа', () => {

  /**
   * ⚠️ Это и есть проверка инварианта: два одновременных запроса с
   * ОДНИМ ключом должны дать один заказ. Решать должна база — если
   * решает код, тест краснеет.
   */
  it('два одновременных заказа с одним Idempotency-Key дают один заказ', async () => {
    // ⚠️ Фикстура создаётся НЕ в откатываемой транзакции, в отличие от
    // остальных тестов файла: конкурирующие соединения не видят данных
    // незафиксированной транзакции, и обе вставки падали бы на внешнем
    // ключе тенанта — тест «краснел» бы не по своей причине. Первая
    // попытка была именно такой: «вставок 0, коммитов 2».
    const setup = await pool().connect()
    let f: Fixture
    const key = `race-${Date.now()}`
    try {
      f = await fixture(setup)
    } finally {
      setup.release()
    }

    const a = await pool().connect()
    const b = await pool().connect()
    try {
      for (const k of [a, b]) {
        await k.query('BEGIN')
        await k.query(`SELECT set_config('app.tenant_id', $1, true)`, [f.tenantId])
      }

      // ⚠️ Вторая вставка БЛОКИРУЕТСЯ до решения первой — так и работает
      // уникальный индекс: Postgres держит её, пока не узнает, будет
      // ли первая зафиксирована. Поэтому ждать обе сразу нельзя:
      // первая попытка так и висела 30 секунд до таймаута теста, и это
      // было не «тест сломан», а доказательство, что индекс работает.
      //
      // Порядок честный: A вставляет и фиксируется, B пытается
      // параллельно и получает отказ — ровно как два запроса клиента.
      const first = insertOrder(a, f, 'RACE01', key)
      const second = insertOrder(b, f, 'RACE02', key)

      await first
      await a.query('COMMIT')

      // Теперь блокировка снята, и B узнаёт свой вердикт.
      const results = await Promise.allSettled([Promise.resolve(), second])
      const commits = await Promise.allSettled([
        Promise.resolve({ rowCount: 1 }), b.query('COMMIT'),
      ])

      const check = await pool().connect()
      try {
        const { rows } = await check.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM rental_order
           WHERE tenant_id = $1 AND price_breakdown->>'idemKey' = $2`,
          [f.tenantId, key],
        )
        const inserted = results.filter((r) => r.status === 'fulfilled').length
        const committed = commits.filter((r) => r.status === 'fulfilled').length
        expect(
          Number(rows[0]!.n),
          `вставок ${inserted}, коммитов ${committed}: один ключ дал больше одного заказа`,
        ).toBe(1)
      } finally {
        check.release()
      }
    } finally {
      for (const k of [a, b]) {
        try { await k.query('ROLLBACK') } catch { /* уже зафиксирована */ }
        k.release()
      }
      await cleanup(f!.tenantId)
    }
  })

  /**
   * ⚠️ Проигравший гонку обязан получить ТОТ ЖЕ заказ, а не ошибку.
   *
   * Индекс закрывает дыру, но сам по себе превращает второй запрос в
   * `23505`, и без обработки клиент видел «Внутренняя ошибка» — при
   * том что бронь создана. Проверено вживую двумя одновременными
   * запросами: победитель 200, проигравший 500. После обработки —
   * оба 200 и один заказ.
   *
   * Здесь проверяется сам механизм: после отказа индекса заказ
   * НАХОДИТСЯ по ключу, то есть ответ проигравшему есть что дать.
   */
  it('после отказа индекса заказ находится по ключу — есть что отдать проигравшему', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const key = 'loser-gets-the-order'
      await insertOrder(c, f, 'WIN001', key)

      // ⚠️ Вторая вставка — под SAVEPOINT. После `23505` транзакция
      // ПРЕРВАНА («current transaction is aborted»), и любой следующий
      // запрос в ней отвергается. Первая версия теста этого не учла и
      // падала не на проверке, а на невозможности что-либо спросить.
      //
      // В рабочем коде эту роль играет НОВАЯ транзакция: обработчик в
      // catch зовёт `deps.db.tx(...)` заново, а не продолжает упавшую.
      // Тест воспроизводит то же поведение откатом до точки.
      let code: string | undefined
      await c.query('SAVEPOINT try_dup')
      try {
        await insertOrder(c, f, 'LOSE01', key)
      } catch (err) {
        code = (err as { code?: string }).code
        await c.query('ROLLBACK TO SAVEPOINT try_dup')
      }
      expect(code, 'индекс не сработал — вторая вставка прошла').toBe('23505')

      // ⚠️ Именно этот запрос делает обработчик в catch. Если он ничего
      // не находит, проигравшему нечего отдать, и остаётся только 500.
      const { rows } = await c.query<{ public_code: string, status: string }>(
        `SELECT public_code, status FROM rental_order
         WHERE tenant_id = $1 AND price_breakdown->>'idemKey' = $2`,
        [f.tenantId, key],
      )
      expect(rows[0]?.public_code, 'заказ по ключу не найден').toBe('WIN001')
      expect(rows[0]?.status).toBe('awaiting_confirm')
    })
  })

  /**
   * ⚠️ Ключ уникален В ПРЕДЕЛАХ ТЕНАНТА, а не глобально: ключ
   * генерирует клиент, и два проката могут прислать одинаковый.
   * Глобальная уникальность отказала бы второму прокату в заказе —
   * утечка изоляции через отказ.
   */
  it('одинаковый ключ у РАЗНЫХ прокатов — два заказа, это не дубль', async () => {
    await inRollback(async (c) => {
      const f1 = await fixture(c)
      const f2 = await fixture(c)
      const key = 'same-key-different-tenants'

      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [f1.tenantId])
      await insertOrder(c, f1, 'TEN1AA', key)
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [f2.tenantId])
      await insertOrder(c, f2, 'TEN2AA', key)

      const { rows } = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM rental_order
         WHERE price_breakdown->>'idemKey' = $1`, [key],
      )
      expect(Number(rows[0]!.n), 'ключ стал уникальным глобально').toBe(2)
    })
  })

  /**
   * ⚠️ Заказы БЕЗ ключа не должны мешать друг другу: клиент, пришедший
   * с витрины без ретраев, ключ не присылает вовсе, и таких заказов
   * тысячи. Уникальный индекс обязан их игнорировать — иначе второй
   * заказ без ключа получит отказ на пустом месте.
   */
  it('заказы без ключа идемпотентности не конфликтуют', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      await insertOrder(c, f, 'NOKEY1', null as unknown as string)
      await insertOrder(c, f, 'NOKEY2', null as unknown as string)

      const { rows } = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM rental_order WHERE tenant_id = $1`,
        [f.tenantId],
      )
      expect(Number(rows[0]!.n), 'заказы без ключа стали конфликтовать').toBe(2)
    })
  })
})
