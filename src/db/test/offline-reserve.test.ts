/**
 * Резерв под выдачу с улицы (10.10, ТЗ 13-оффлайн).
 *
 * ⚠️ Админка обещает тенанту прямым текстом: «Она всегда остаётся для
 * тех, кто пришёл без брони, но забронировать её онлайн нельзя»
 * (app/pages/admin/offline.vue). Настройка сохранялась в
 * branch_offline_reserve и не читалась НИГДЕ — резерв не резервировал
 * ничего, онлайн разбирал весь склад, а приход без брони оставался ни
 * с чем. Худший вид дефекта: настройка выглядит рабочей и молчит.
 *
 * ⚠️ Резерв — пятая ось недоступности, рядом с сезоном, расписанием
 * филиала, ёмкостью пула и отключением позиции (18.2). Как и
 * отключение, он НЕ трогает счётчики пула: пул говорит «сколько
 * физически есть», резерв — «сколько из этого не продавать онлайн».
 * Смешать их — значит потерять реальные брони при смене резерва.
 *
 * ⚠️ Резерв уменьшает доступное К БРОНИРОВАНИЮ, но не физическое
 * наличие: в том и смысл, что вещь лежит на складе и её выдают с
 * улицы. Железное правило 12 — расхождение не блокирует работу.
 */
import { describe, expect, it } from 'vitest'
import { checkAvailability, physicalStock } from '~/domain/availability/availability'
import { inRollback } from './setup'

const TZ = 'Asia/Krasnoyarsk'
const DAY = 86_400_000

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
     VALUES ($1, $2, $3, 'sb-157', '{"ru":"157"}') RETURNING id`,
    [t.id, b.id, cat.id],
  )
  return {
    tenantId: t.id as string,
    branchId: b.id as string,
    categoryId: cat.id as string,
    variantId: v.id as string,
  }
}

async function stock(
  c: import('pg').PoolClient,
  f: { tenantId: string, variantId: string },
  days: string[],
  capacity: number,
) {
  for (const d of days) {
    await c.query(
      `INSERT INTO pool_day (tenant_id, variant_id, day, capacity, qty_booked)
       VALUES ($1, $2, $3::date, $4, 0)
       ON CONFLICT (variant_id, day) DO UPDATE SET capacity = excluded.capacity`,
      [f.tenantId, f.variantId, d, capacity],
    )
  }
}

async function setReserve(
  c: import('pg').PoolClient,
  f: { tenantId: string, branchId: string, categoryId: string },
  mode: 'percent' | 'absolute',
  value: number,
) {
  await c.query(
    `INSERT INTO branch_offline_reserve (tenant_id, branch_id, category_id, mode, value)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (branch_id, category_id)
     DO UPDATE SET mode = excluded.mode, value = excluded.value`,
    [f.tenantId, f.branchId, f.categoryId, mode, value],
  )
}

function isoDays(from: Date, count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    new Date(from.getTime() + i * DAY).toISOString().slice(0, 10))
}

const FROM = new Date('2027-01-11T03:00:00Z')
const TO = new Date('2027-01-13T03:00:00Z')

describe('резерв под выдачу с улицы', () => {
  it('без резерва доступен весь пул', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      await stock(c, f, isoDays(FROM, 4), 10)

      const r = await checkAvailability(c, {
        tenantId: f.tenantId, variantId: f.variantId, from: FROM, to: TO, timezone: TZ,
      })

      expect(r.freeUnits).toBe(10)
    })
  })

  it('⚠️ резерв в процентах уменьшает доступное к бронированию', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      await stock(c, f, isoDays(FROM, 4), 10)
      await setReserve(c, f, 'percent', 30)

      const r = await checkAvailability(c, {
        tenantId: f.tenantId, variantId: f.variantId, from: FROM, to: TO, timezone: TZ,
      })

      // 30% от 10 придержано под улицу — онлайн остаётся 7.
      expect(r.freeUnits).toBe(7)
    })
  })

  it('резерв числом придерживает ровно столько единиц', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      await stock(c, f, isoDays(FROM, 4), 10)
      await setReserve(c, f, 'absolute', 4)

      const r = await checkAvailability(c, {
        tenantId: f.tenantId, variantId: f.variantId, from: FROM, to: TO, timezone: TZ,
      })

      expect(r.freeUnits).toBe(6)
    })
  })

  it('⚠️ резерв больше пула не уводит доступное в минус', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      await stock(c, f, isoDays(FROM, 4), 2)
      await setReserve(c, f, 'absolute', 5)

      const r = await checkAvailability(c, {
        tenantId: f.tenantId, variantId: f.variantId, from: FROM, to: TO, timezone: TZ,
      })

      // Ноль, а не −3: отрицательное свободное пролезло бы в витрину
      // и в арифметику пула.
      expect(r.freeUnits).toBe(0)
      expect(r.available).toBe(false)
    })
  })

  it('⚠️ резерв не трогает физическое наличие — вещь на складе и выдаётся с улицы', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      await stock(c, f, isoDays(FROM, 4), 10)
      await setReserve(c, f, 'percent', 30)
      await c.query(
        `INSERT INTO movement (tenant_id, branch_id, variant_id, qty, kind)
         VALUES ($1, $2, $3, 10, 'receipt')`,
        [f.tenantId, f.branchId, f.variantId],
      )

      // Онлайн видит 7, на складе по-прежнему 10 — в этом и смысл
      // резерва: придержанное выдаётся тому, кто пришёл без брони.
      expect(await physicalStock(c, f.tenantId, f.variantId)).toBe(10)
    })
  })

  it('⚠️ процент считается по КАЖДОМУ дню, а не по максимуму интервала', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const days = isoDays(FROM, 4)
      // Ёмкость разная по дням: часть парка уехала на выставку.
      await stock(c, f, [days[0]!, days[1]!], 10)
      await stock(c, f, [days[2]!, days[3]!], 4)
      await setReserve(c, f, 'percent', 50)

      const r = await checkAvailability(c, {
        tenantId: f.tenantId, variantId: f.variantId, from: FROM, to: TO, timezone: TZ,
      })

      // День с ёмкостью 4 обязан придержать 2 и отдать 2, а не вычесть
      // 5 (50% от максимума 10) и уйти в ноль. Иначе резерв в проценте
      // от чужого дня съедает наличие там, где парк меньше.
      expect(r.freeUnits).toBe(2)
    })
  })

  it('резерв категории не действует на чужую категорию', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const { rows: [other] } = await c.query(
        `INSERT INTO category (tenant_id, code, name, tracking)
         VALUES ($1, 'helmet', '{"ru":"Шлем"}', 'count') RETURNING id`,
        [f.tenantId],
      )
      const { rows: [ov] } = await c.query(
        `INSERT INTO inventory_variant (tenant_id, branch_id, category_id, code, name)
         VALUES ($1, $2, $3, 'hl-m', '{"ru":"M"}') RETURNING id`,
        [f.tenantId, f.branchId, other.id],
      )
      await stock(c, { tenantId: f.tenantId, variantId: ov.id }, isoDays(FROM, 4), 10)
      await setReserve(c, f, 'percent', 50)

      const r = await checkAvailability(c, {
        tenantId: f.tenantId, variantId: ov.id, from: FROM, to: TO, timezone: TZ,
      })

      expect(r.freeUnits).toBe(10)
    })
  })
})
