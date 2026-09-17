/**
 * Календарь наличия (`pool_day`) для вновь заведённых позиций.
 *
 * ⚠️ ДЕФЕКТ 19.34: новый вариант с количественным учётом не продавался
 * НИКОГДА. Строки `pool_day` заполнял только демо-сидер, а приход делал
 * `UPDATE pool_day … WHERE variant_id = …` — при отсутствии строк это
 * «UPDATE 0», молча. Наружу: админка отвечает успехом, движение
 * записано, остаток по движениям верный — и только витрина показывает
 * позицию занятой навсегда.
 *
 * ⚠️ Существующие тесты этого не ловили, потому что САМИ вставляли
 * `pool_day` перед проверкой (`withPool` в items.test.ts). Здесь
 * календарь НЕ создаётся руками — только через рабочий поток, иначе
 * тест проверял бы собственную подготовку данных.
 */
import { describe, expect, it } from 'vitest'
import { adjustQuantity } from '~/domain/admin/admin'
import { checkAvailability } from '~/domain/availability/availability'
import { setCategoryTracking } from '~/domain/inventory/items'
import { inRollback } from '../../../db/test/setup'

const TZ = 'Asia/Krasnoyarsk'

const day = (offset: number) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return d.toISOString().slice(0, 10)
}

/** Тенант, филиал, категория со счётным учётом и вариант. Без pool_day. */
async function fixture(c: import('pg').PoolClient) {
  const { rows: [t] } = await c.query(
    `INSERT INTO tenant (slug, name) VALUES ('t-' || gen_random_uuid(), 'Тест') RETURNING id`,
  )
  const { rows: [b] } = await c.query(
    `INSERT INTO branch (tenant_id, name) VALUES ($1, 'Филиал') RETURNING id`, [t.id],
  )
  const { rows: [cat] } = await c.query(
    `INSERT INTO category (tenant_id, code, name, tracking)
     VALUES ($1, 'gloves', '{"ru":"Перчатки"}', 'count'::tracking_mode) RETURNING id`,
    [t.id],
  )
  const { rows: [v] } = await c.query(
    `INSERT INTO inventory_variant (tenant_id, branch_id, category_id, code, name)
     VALUES ($1, $2, $3, 'gl-xl', '{"ru":"XL"}') RETURNING id`,
    [t.id, b.id, cat.id],
  )
  const { rows: [s] } = await c.query(
    `INSERT INTO staff (tenant_id, email, name, role)
     VALUES ($1, 'o-' || gen_random_uuid() || '@t.local', 'Владелец', 'owner') RETURNING id`,
    [t.id],
  )
  return { tenantId: t.id, branchId: b.id, categoryId: cat.id, variantId: v.id, staffId: s.id }
}

describe('⚠️ 19.34: поступление на новый вариант', () => {
  it('создаёт календарь наличия, а не меняет ноль строк', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)

      const { rows: before } = await c.query(
        `SELECT count(*)::int AS n FROM pool_day WHERE variant_id = $1`, [f.variantId],
      )
      expect(before[0]!.n, 'у нового варианта календаря ещё нет').toBe(0)

      await adjustQuantity(c, {
        tenantId: f.tenantId, branchId: f.branchId, variantId: f.variantId,
        delta: 5, staffId: f.staffId, reason: 'поступление',
      })

      const { rows: after } = await c.query(
        `SELECT count(*)::int AS n, min(capacity)::int AS min FROM pool_day WHERE variant_id = $1`,
        [f.variantId],
      )
      expect(after[0]!.n, 'календарь заведён').toBeGreaterThan(0)
      expect(after[0]!.min, 'ёмкость равна привезённому количеству').toBe(5)
    })
  })

  /**
   * ⚠️ Суть дефекта в терминах продукта: прокат завёл позицию, привёз
   * товар — и не может его продать.
   */
  it('привезённое становится доступно к брони', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)

      await adjustQuantity(c, {
        tenantId: f.tenantId, branchId: f.branchId, variantId: f.variantId,
        delta: 5, staffId: f.staffId, reason: 'поступление',
      })

      const a = await checkAvailability(c, {
        tenantId: f.tenantId, variantId: f.variantId, qty: 1, timezone: TZ,
        from: new Date(`${day(3)}T00:00:00Z`), to: new Date(`${day(4)}T00:00:00Z`),
      })

      expect(a.available, 'позиция продаётся').toBe(true)
      expect(a.freeUnits).toBe(5)
    })
  })

  /**
   * ⚠️ Повторный приход ПРИБАВЛЯЕТ, а не перезаписывает: «привезли ещё
   * три» должно давать восемь, а не три. Сидер задаёт абсолютную
   * ёмкость — здесь это было бы потерей склада.
   */
  it('второй приход прибавляется к первому', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const add = (delta: number) => adjustQuantity(c, {
        tenantId: f.tenantId, branchId: f.branchId, variantId: f.variantId,
        delta, staffId: f.staffId, reason: 'поступление',
      })

      await add(5)
      await add(3)

      const { rows } = await c.query(
        `SELECT min(capacity)::int AS min FROM pool_day WHERE variant_id = $1`, [f.variantId],
      )
      expect(rows[0]!.min).toBe(8)
    })
  })

  /**
   * ⚠️ Списание не уводит ёмкость в минус: отрицательная ёмкость
   * сломала бы расчёт свободных единиц.
   */
  it('списание больше остатка оставляет ноль, а не минус', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      await adjustQuantity(c, {
        tenantId: f.tenantId, branchId: f.branchId, variantId: f.variantId,
        delta: 2, staffId: f.staffId, reason: 'поступление',
      })
      await adjustQuantity(c, {
        tenantId: f.tenantId, branchId: f.branchId, variantId: f.variantId,
        delta: -5, staffId: f.staffId, reason: 'списание после ревизии',
      })

      const { rows } = await c.query(
        `SELECT min(capacity)::int AS min FROM pool_day WHERE variant_id = $1`, [f.variantId],
      )
      expect(rows[0]!.min).toBe(0)
    })
  })
})

describe('⚠️ возврат категории на счётный учёт', () => {
  /**
   * ⚠️ Зеркало того же дефекта. При поимённом учёте `pool_day` не
   * читается вовсе, и у варианта, заведённого сразу как `labeled`,
   * строк там нет. Обратный перевод разрешён продуктом («вернуть
   * категорию на счётчик можно, а выбросить историю вещей — нет») —
   * и без календаря позиция стала бы непродаваемой в тот же миг.
   */
  it('заводит календарь наличия по остатку из движений', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)

      // Приход и перевод на поимённый учёт: календарь становится ненужным.
      await adjustQuantity(c, {
        tenantId: f.tenantId, branchId: f.branchId, variantId: f.variantId,
        delta: 4, staffId: f.staffId, reason: 'поступление',
      })
      await setCategoryTracking(c, {
        tenantId: f.tenantId, categoryId: f.categoryId,
        tracking: 'labeled', staffId: f.staffId,
      })

      // ⚠️ Имитируем вариант, заведённый УЖЕ поимённым: календаря нет.
      await c.query(`DELETE FROM pool_day WHERE variant_id = $1`, [f.variantId])

      await setCategoryTracking(c, {
        tenantId: f.tenantId, categoryId: f.categoryId,
        tracking: 'count', staffId: f.staffId,
      })

      const a = await checkAvailability(c, {
        tenantId: f.tenantId, variantId: f.variantId, qty: 1, timezone: TZ,
        from: new Date(`${day(3)}T00:00:00Z`), to: new Date(`${day(4)}T00:00:00Z`),
      })

      expect(a.available, 'после возврата на счётчик позиция продаётся').toBe(true)
      expect(a.freeUnits, 'ёмкость взята из журнала движений').toBe(4)
    })
  })
})
