/**
 * Лист ожидания: гонка нескольких, «любая дата в диапазоне»,
 * подсказка соседних дат (17.14).
 *
 * ⚠️ Гонка проверяется НА ДВУХ СОЕДИНЕНИЯХ, а не в одной транзакции:
 * в откатываемой транзакции конкуренции не бывает по построению, и
 * тест «прошёл бы» при полностью сломанном инварианте. Поэтому здесь
 * данные пишутся по-настоящему и убираются в finally.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { inRollback, pool } from '../../../db/test/setup'
import { addToWaitlist, claimOffer, offerToNextInQueue } from '~/domain/availability/waitlist'
import { nearbyWindows } from '~/domain/availability/nearby'

const DAY = 86_400_000

/** Минимальный набор данных. Возвращает id для уборки. */
async function fixture(c: import('pg').PoolClient) {
  const { rows: [t] } = await c.query(
    `INSERT INTO tenant (slug, name) VALUES ('t-' || gen_random_uuid(), 'Тест')
     RETURNING id`,
  )
  const { rows: [b] } = await c.query(
    `INSERT INTO branch (tenant_id, name) VALUES ($1, 'Филиал') RETURNING id`,
    [t.id],
  )
  const { rows: [cat] } = await c.query(
    `INSERT INTO category (tenant_id, code, name, tracking)
     VALUES ($1, 'board', '{"ru":"Сноуборд"}', 'count') RETURNING id`,
    [t.id],
  )
  const { rows: [v] } = await c.query(
    `INSERT INTO inventory_variant (tenant_id, branch_id, category_id, code, name)
     VALUES ($1, $2, $3, 'board-157', '{"ru":"Сноуборд 157"}') RETURNING id`,
    [t.id, b.id, cat.id],
  )
  return { tenantId: t.id, branchId: b.id, variantId: v.id }
}

/** Клиент с уникальным телефоном. */
async function customer(c: import('pg').PoolClient, tenantId: string, n: number) {
  const { rows: [cu] } = await c.query(
    `INSERT INTO customer (tenant_id, phone, name)
     VALUES ($1, $2, $3) RETURNING id`,
    [tenantId, `+7999${Date.now() % 1_000_000}${n}`, `Клиент ${n}`],
  )
  return cu.id as string
}

/**
 * Уборка за тестом, который писал по-настоящему.
 *
 * ⚠️ Порядок от листьев к корню: внешние ключи без ON DELETE CASCADE —
 * это осознанное решение, а не недосмотр.
 */
async function cleanup(c: import('pg').PoolClient, tenantId: string) {
  // ⚠️ Уборка не должна падать: если тест уже упал, вторая ошибка
  // здесь скроет первую, а мусор в базе останется всё равно.
  // Проверено на практике: три прерванных прогона оставили три
  // тенанта «Тест», и они всплыли в демо-данных обхода.
  try {
    for (const t of ['waitlist', 'pool_day', 'outbox', 'event', 'customer',
                     'inventory_variant', 'category', 'branch']) {
      await c.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [tenantId])
    }
    await c.query(`DELETE FROM tenant WHERE id = $1`, [tenantId])
  } catch (e) {
    console.error('Уборка после теста не удалась:', e)
  }
}

/**
 * Подстраховка: убирает тенантов, оставшихся от прерванных прогонов.
 *
 * ⚠️ Нужна потому, что аварийное завершение (упавший assert, Ctrl+C,
 * таймаут) до finally не доходит. Без неё мусор копится молча
 * и однажды попадает в демо-данные.
 */
afterAll(async () => {
  const c = await pool().connect()
  try {
    const { rows } = await c.query<{ id: string }>(
      `SELECT id FROM tenant WHERE name = 'Тест' AND slug LIKE 't-%'`,
    )
    for (const r of rows) await cleanup(c, r.id)
  } finally {
    c.release()
  }
})

describe('гонка за освободившуюся позицию', () => {
  it('из троих приглашённых позицию забирает ровно один', async () => {
    const c = await pool().connect()
    let tenantId = ''
    try {
      const f = await fixture(c)
      tenantId = f.tenantId
      const from = new Date(Date.now() + 3 * DAY)
      const to = new Date(Date.now() + 5 * DAY)

      // Трое встают в очередь по одному варианту и интервалу.
      for (let n = 1; n <= 3; n++) {
        await addToWaitlist(c, {
          tenantId: f.tenantId,
          branchId: f.branchId,
          variantId: f.variantId,
          customerId: await customer(c, f.tenantId, n),
          from,
          to,
        })
      }

      const offered = await offerToNextInQueue(c, {
        tenantId: f.tenantId,
        variantId: f.variantId,
        from,
        to,
      })
      // Приглашают всех троих сразу, а не одного: позиция не должна
      // простаивать 45 минут из-за одного молчащего.
      expect(offered).toHaveLength(3)
      expect(offered.every((o) => o.offerToken)).toBe(true)

      // ⚠️ Одновременно, на РАЗНЫХ соединениях: это и есть гонка.
      const conns = await Promise.all(offered.map(() => pool().connect()))
      try {
        const results = await Promise.all(
          offered.map((o, i) => claimOffer(conns[i]!, o.offerToken!)),
        )
        const won = results.filter((r) => r.ok)
        const lost = results.filter((r) => !r.ok)

        // Победитель ровно один — и это решает уникальный индекс,
        // а не порядок операций в коде.
        expect(won).toHaveLength(1)
        expect(lost).toHaveLength(2)
        // Проигравшим говорим честно, что произошло.
        expect(lost.every((r) => !r.ok && r.reason === 'taken')).toBe(true)
      } finally {
        for (const k of conns) k.release()
      }
    } finally {
      // ⚠️ Уборка идёт от листьев к корню: каскадного удаления
      // у тенанта нет намеренно — «удалить прокат одним DELETE»
      // не должно быть однострочником.
      if (tenantId) await cleanup(c, tenantId)
      c.release()
    }
  })

  it('чужой токен не забирает предложение', async () => {
    await inRollback(async (c) => {
      const out = await claimOffer(c, 'заведомо-не-существующий-токен')
      expect(out.ok).toBe(false)
      expect(out.ok === false && out.reason).toBe('unknown')
    })
  })
})

describe('«любая дата в диапазоне»', () => {
  it('запись с диапазоном ловит освобождение вне желаемых дат', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const from = new Date(Date.now() + 3 * DAY)
      const to = new Date(Date.now() + 4 * DAY)

      await addToWaitlist(c, {
        tenantId: f.tenantId,
        branchId: f.branchId,
        variantId: f.variantId,
        customerId: await customer(c, f.tenantId, 1),
        from,
        to,
        // Согласен на любые сутки в пределах недели.
        searchFrom: new Date(Date.now() + 1 * DAY),
        searchTo: new Date(Date.now() + 8 * DAY),
      })

      // Освободились ДРУГИЕ сутки — те, что клиент не просил,
      // но которые попадают в его диапазон.
      const offered = await offerToNextInQueue(c, {
        tenantId: f.tenantId,
        variantId: f.variantId,
        from: new Date(Date.now() + 6 * DAY),
        to: new Date(Date.now() + 7 * DAY),
      })
      expect(offered).toHaveLength(1)
    })
  })

  it('без диапазона несовпадающие даты не предлагаются', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)

      await addToWaitlist(c, {
        tenantId: f.tenantId,
        branchId: f.branchId,
        variantId: f.variantId,
        customerId: await customer(c, f.tenantId, 1),
        from: new Date(Date.now() + 3 * DAY),
        to: new Date(Date.now() + 4 * DAY),
      })

      const offered = await offerToNextInQueue(c, {
        tenantId: f.tenantId,
        variantId: f.variantId,
        from: new Date(Date.now() + 6 * DAY),
        to: new Date(Date.now() + 7 * DAY),
      })
      expect(offered).toHaveLength(0)
    })
  })

  it('диапазон уже желаемого интервала отклоняется', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      await expect(addToWaitlist(c, {
        tenantId: f.tenantId,
        branchId: f.branchId,
        variantId: f.variantId,
        customerId: await customer(c, f.tenantId, 1),
        from: new Date(Date.now() + 3 * DAY),
        to: new Date(Date.now() + 6 * DAY),
        searchFrom: new Date(Date.now() + 4 * DAY),
        searchTo: new Date(Date.now() + 5 * DAY),
      })).rejects.toThrow()
    })
  })
})

describe('подсказка соседних дат', () => {
  it('находит свободное окно той же длительности рядом', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)

      // Ёмкость на две недели вперёд, суббота и воскресенье заняты.
      const base = new Date()
      for (let n = 0; n <= 20; n++) {
        const day = new Date(base.getTime() + n * DAY).toISOString().slice(0, 10)
        await c.query(
          `INSERT INTO pool_day (tenant_id, variant_id, day, capacity, qty_booked)
           VALUES ($1, $2, $3, 2, $4)`,
          [f.tenantId, f.variantId, day, n === 5 || n === 6 ? 2 : 0],
        )
      }

      const found = await nearbyWindows(c, {
        variantId: f.variantId,
        from: new Date(base.getTime() + 5 * DAY),
        to: new Date(base.getTime() + 6 * DAY),
        timezone: 'UTC',
      })

      expect(found.length).toBeGreaterThan(0)
      // ⚠️ Длительность сохраняется: подсказка двигает окно,
      // а не урезает аренду.
      for (const w of found) {
        const nights = Math.round((w.to.getTime() - w.from.getTime()) / DAY)
        expect(nights).toBe(1)
        expect(w.freeUnits).toBeGreaterThanOrEqual(1)
      }
      // ⚠️ Ближайшее окно — −2, а не −1: запрошены ДВОЕ суток
      // (дни 5 и 6), и сдвиг на один день всё ещё накрывает занятый
      // день 5. Проверяется именно это — окно целиком свободно,
      // а не «начало свободно».
      expect(found[0]!.shiftDays).toBe(-2)
    })
  })

  it('когда занято всё вокруг — подсказок нет, а не выдумка', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const base = new Date()
      for (let n = 0; n <= 20; n++) {
        const day = new Date(base.getTime() + n * DAY).toISOString().slice(0, 10)
        await c.query(
          `INSERT INTO pool_day (tenant_id, variant_id, day, capacity, qty_booked)
           VALUES ($1, $2, $3, 1, 1)`,
          [f.tenantId, f.variantId, day],
        )
      }

      const found = await nearbyWindows(c, {
        variantId: f.variantId,
        from: new Date(base.getTime() + 5 * DAY),
        to: new Date(base.getTime() + 6 * DAY),
        timezone: 'UTC',
      })
      expect(found).toEqual([])
    })
  })
})
