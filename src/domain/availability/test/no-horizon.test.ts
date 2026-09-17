/**
 * Наличие за пределами заполненного календаря (19.43).
 *
 * ⚠️ `pool_day` заполнялся ЗАРАНЕЕ на 90–120 дней вперёд и дальше
 * не рос. За этой границей строк нет — и наличие считалось нулевым:
 * позиция показывалась занятой при полном складе. Замерено на стенде:
 * бронь через 100 дней `freeUnits: 7`, через 130 дней `freeUnits: 0`.
 *
 * ⚠️ Отсутствие строки означает «в этот день никто ничего не бронировал»,
 * то есть свободно ВСЁ. Строка заводится в момент брони, а не заранее:
 * 95% строк на стенде (2146 из 2254) хранили «забронировано 0» —
 * заполнялось то, что почти никогда не пригодится.
 *
 * ⚠️ Защита от двойной продажи при этом СОХРАНЯЕТСЯ: строка создаётся
 * в той же транзакции, что и бронь, а `CHECK (qty_booked <= capacity)`
 * отклоняет вторую попытку занять последнюю единицу. Проверка в коде
 * так не умеет — между «посмотрел» и «записал» всегда есть щель.
 */
import { describe, expect, it } from 'vitest'
import { checkAvailability, releasePool, reservePool } from '~/domain/availability/availability'
import { inRollback } from '../../../db/test/setup'

const TZ = 'Asia/Krasnoyarsk'

const day = (offset: number) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return d.toISOString().slice(0, 10)
}

async function fixture(c: import('pg').PoolClient, tracking = 'count') {
  const { rows: [t] } = await c.query(
    `INSERT INTO tenant (slug, name) VALUES ('t-' || gen_random_uuid(), 'Тест') RETURNING id`,
  )
  const { rows: [b] } = await c.query(
    `INSERT INTO branch (tenant_id, name) VALUES ($1, 'Филиал') RETURNING id`, [t.id],
  )
  const { rows: [cat] } = await c.query(
    `INSERT INTO category (tenant_id, code, name, tracking)
     VALUES ($1, 'board', '{"ru":"Сноуборд"}', $2::tracking_mode) RETURNING id`,
    [t.id, tracking],
  )
  const { rows: [v] } = await c.query(
    `INSERT INTO inventory_variant (tenant_id, branch_id, category_id, code, name)
     VALUES ($1, $2, $3, 'sb-157', '{"ru":"157"}') RETURNING id`,
    [t.id, b.id, cat.id],
  )
  return { tenantId: t.id, branchId: b.id, categoryId: cat.id, variantId: v.id }
}

/** Календарь на ближние дни — как его заполняет приход. */
async function poolUntil(
  c: import('pg').PoolClient,
  f: { tenantId: string, variantId: string },
  lastDay: number,
  capacity: number,
) {
  await c.query(
    `INSERT INTO pool_day (tenant_id, variant_id, day, qty_booked, capacity)
     SELECT $1, $2, d::date, 0, $3
       FROM generate_series(current_date, current_date + $4::int, '1 day') AS d`,
    [f.tenantId, f.variantId, capacity, lastDay],
  )
}

function ask(c: import('pg').PoolClient, f: { tenantId: string, variantId: string }, from: number, to: number) {
  return checkAvailability(c, {
    tenantId: f.tenantId, variantId: f.variantId, qty: 1, timezone: TZ,
    from: new Date(`${day(from)}T00:00:00Z`),
    to: new Date(`${day(to)}T00:00:00Z`),
  })
}

describe('⚠️ 19.43: горизонта календаря нет', () => {
  it('день за границей заполненного календаря СВОБОДЕН', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      await poolUntil(c, f, 10, 5)

      const inside = await ask(c, f, 3, 4)
      expect(inside.freeUnits, 'внутри календаря').toBe(5)

      // ⚠️ Суть: за 10-м днём строк нет. Склад тот же, брони нет —
      // значит свободно столько же.
      const beyond = await ask(c, f, 30, 31)
      expect(beyond.available, 'позиция продаётся и за горизонтом').toBe(true)
      expect(beyond.freeUnits).toBe(5)
    })
  })

  it('бронь за горизонтом уменьшает свободное на свою штуку', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      await poolUntil(c, f, 10, 5)

      // Бронь на дальнюю дату заводит строку сама.
      await c.query(
        `INSERT INTO pool_day (tenant_id, variant_id, day, qty_booked, capacity)
         VALUES ($1, $2, (current_date + 30)::date, 2, 5)`,
        [f.tenantId, f.variantId],
      )

      const r = await ask(c, f, 30, 31)
      expect(r.freeUnits, '5 всего минус 2 занятых').toBe(3)
    })
  })

  it('интервал, пересекающий границу, считается целиком', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      await poolUntil(c, f, 10, 5)

      // ⚠️ Дни 8–12: часть в календаре, часть за ним. Раньше вторая
      // половина обнуляла ответ, и бронь «на неделю» упиралась
      // в невидимую стену посреди интервала.
      const r = await ask(c, f, 8, 12)
      expect(r.available).toBe(true)
      expect(r.freeUnits).toBe(5)
      expect(r.shortageDays).toEqual([])
    })
  })
})

describe('⚠️ 19.43: бронь за горизонтом записывается', () => {
  /**
   * ⚠️ Вторая половина дефекта, и она опаснее первой. `reservePool`
   * делал `UPDATE pool_day` — при отсутствии строки это «UPDATE 0»,
   * молча. Показывать позицию свободной за горизонтом, но не учитывать
   * там брони, значит продать одну вещь дважды: ровно то, от чего
   * защищает `CHECK (qty_booked <= capacity)`, которого без строки нет.
   */
  it('занимает единицы в дне, которого не было в календаре', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      await poolUntil(c, f, 10, 5)

      const req = {
        tenantId: f.tenantId, variantId: f.variantId, qty: 2, timezone: TZ,
        from: new Date(`${day(30)}T00:00:00Z`),
        to: new Date(`${day(31)}T00:00:00Z`),
      }
      await reservePool(c, req)

      const r = await ask(c, f, 30, 31)
      expect(r.freeUnits, '5 всего минус 2 занятых').toBe(3)

      // И освобождение работает по той же строке.
      await releasePool(c, req)
      expect((await ask(c, f, 30, 31)).freeUnits).toBe(5)
    })
  })

  /**
   * ⚠️ Двойная продажа последней единицы отклоняется БАЗОЙ, а не кодом:
   * между «посмотрел — свободно» и «записал» всегда есть щель.
   */
  it('переполнение за горизонтом отклоняется CHECK, а не проверкой в коде', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      await poolUntil(c, f, 10, 2)

      const req = (qty: number) => ({
        tenantId: f.tenantId, variantId: f.variantId, qty, timezone: TZ,
        from: new Date(`${day(40)}T00:00:00Z`),
        to: new Date(`${day(41)}T00:00:00Z`),
      })

      await reservePool(c, req(2))
      await expect(reservePool(c, req(1)), 'третья единица при ёмкости 2').rejects.toThrow()
    })
  })
})
