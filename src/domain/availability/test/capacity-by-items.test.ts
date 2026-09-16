/**
 * Наличие при поимённом учёте считается ПО ЕДИНИЦАМ, а не по пулу.
 *
 * ⚠️ Это разрешение спора двух механизмов. До правки `pool_day` и
 * реальные вещи были двумя независимыми правдами, и они разошлись:
 * на стенде sb-157 имел 11 вещей физически и 6 в счётчике — витрина
 * не продавала половину парка и НЕ СООБЩАЛА об этом.
 *
 * ⚠️ Синхронизировать счётчик было бы седьмым местом, где его можно
 * забыть обновить (сейчас их шесть). Вычисляемое значение забыть
 * нельзя — поэтому при `labeled` pool_day не участвует вовсе.
 */
import { describe, expect, it } from 'vitest'
import { checkAvailability } from '~/domain/availability/availability'
import { createItems } from '~/domain/inventory/items'
import { poolDrift } from '~/domain/counter/stocktake'
import { inRollback } from '../../../db/test/setup'

const TZ = 'Asia/Krasnoyarsk'

function day(offset: number): string {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return d.toISOString().slice(0, 10)
}

async function fixture(c: import('pg').PoolClient, tracking = 'labeled') {
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
  const { rows: [s] } = await c.query(
    `INSERT INTO staff (tenant_id, email, name, role)
     VALUES ($1, 's-' || gen_random_uuid() || '@t.local', 'Стойка', 'counter') RETURNING id`,
    [t.id],
  )
  return { tenantId: t.id, branchId: b.id, categoryId: cat.id, variantId: v.id, staffId: s.id }
}

/** Ставит счётчик пула ЗАВЕДОМО НЕВЕРНЫМ — он не должен влиять. */
async function poolSays(
  c: import('pg').PoolClient,
  f: { tenantId: string, variantId: string },
  capacity: number,
) {
  await c.query(
    `INSERT INTO pool_day (tenant_id, variant_id, day, qty_booked, capacity)
     SELECT $1, $2, d::date, 0, $3
       FROM generate_series(current_date, current_date + 20, '1 day') AS d`,
    [f.tenantId, f.variantId, capacity],
  )
}

function ask(c: import('pg').PoolClient, f: { tenantId: string, variantId: string }, from: number, to: number) {
  return checkAvailability(c, {
    tenantId: f.tenantId, variantId: f.variantId, qty: 1, timezone: TZ,
    from: new Date(`${day(from)}T00:00:00Z`),
    to: new Date(`${day(to)}T00:00:00Z`),
  })
}

describe('поимённый учёт: ёмкость из единиц', () => {
  /**
   * ⚠️ Главный тест спора: счётчик врёт вдвое, а ответ правильный.
   * До правки витрина верила счётчику и недопродавала половину парка.
   */
  it('врущий pool_day не влияет — считаются реальные вещи', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      await createItems(c, { ...f, count: 10, staffId: f.staffId })
      await poolSays(c, f, 3)

      const r = await ask(c, f, 1, 3)
      expect(r.freeUnits).toBe(10)
    })
  })

  it('выданная вещь уменьшает свободное на свою штуку', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const { created } = await createItems(c, { ...f, count: 5, staffId: f.staffId })
      await poolSays(c, f, 99)

      const { rows: [o] } = await c.query<{ id: string }>(
        `INSERT INTO rental_order (tenant_id, branch_pickup_id, public_code, status, period)
         VALUES ($1, $2, 'T-' || substr(gen_random_uuid()::text,1,6), 'issued',
                 tstzrange($3::date, $4::date))
         RETURNING id`,
        [f.tenantId, f.branchId, day(1), day(4)],
      )
      await c.query(
        `INSERT INTO order_line (tenant_id, order_id, variant_id, item_id, qty, period, status)
         VALUES ($1, $2, $3, $4, 1, tstzrange($5::date, $6::date), 'picked_up')`,
        [f.tenantId, o!.id, f.variantId, created[0]!.id, day(1), day(4)],
      )

      expect((await ask(c, f, 1, 3)).freeUnits).toBe(4)
      // ⚠️ После окончания аренды вещь снова свободна — по дням,
      // а не «занята навсегда».
      expect((await ask(c, f, 6, 8)).freeUnits).toBe(5)
    })
  })

  it('вещь в обслуживании не продаётся', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const { created } = await createItems(c, { ...f, count: 4, staffId: f.staffId })
      await poolSays(c, f, 99)

      await c.query(
        `INSERT INTO movement (tenant_id, branch_id, variant_id, item_id, kind, qty, service_kind)
         VALUES ($1, $2, $3, $4, 'to_service', -1, 'repair')`,
        [f.tenantId, f.branchId, f.variantId, created[0]!.id],
      )

      expect((await ask(c, f, 1, 3)).freeUnits).toBe(3)
    })
  })

  it('вернувшаяся из обслуживания снова продаётся', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const { created } = await createItems(c, { ...f, count: 4, staffId: f.staffId })
      await poolSays(c, f, 99)

      await c.query(
        `INSERT INTO movement (tenant_id, branch_id, variant_id, item_id, kind, qty, service_kind)
         VALUES ($1, $2, $3, $4, 'to_service', -1, 'repair')`,
        [f.tenantId, f.branchId, f.variantId, created[0]!.id],
      )
      await c.query(
        `INSERT INTO movement (tenant_id, branch_id, variant_id, item_id, kind, qty)
         VALUES ($1, $2, $3, $4, 'from_service', 1)`,
        [f.tenantId, f.branchId, f.variantId, created[0]!.id],
      )

      expect((await ask(c, f, 1, 3)).freeUnits).toBe(4)
    })
  })

  it('списанная вещь не продаётся', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const { created } = await createItems(c, { ...f, count: 3, staffId: f.staffId })
      await poolSays(c, f, 99)

      await c.query(`UPDATE item SET archived_at = now() WHERE id = $1`, [created[0]!.id])

      expect((await ask(c, f, 1, 3)).freeUnits).toBe(2)
    })
  })

  /** ⚠️ Отключение ПОЗИЦИИ обнуляет всё, отключение ВЕЩИ — минус одна. */
  it('отключение позиции обнуляет, отключение вещи уменьшает', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const { created } = await createItems(c, { ...f, count: 5, staffId: f.staffId })
      await poolSays(c, f, 99)

      await c.query(
        `INSERT INTO item_blackout (tenant_id, item_id, days, reason)
         VALUES ($1, $2, daterange($3::date, $4::date, '[)'), 'ремонт')`,
        [f.tenantId, created[0]!.id, day(1), day(5)],
      )
      expect((await ask(c, f, 1, 3)).freeUnits).toBe(4)

      await c.query(
        `INSERT INTO variant_blackout (tenant_id, variant_id, days, reason)
         VALUES ($1, $2, daterange($3::date, $4::date, '[)'), 'выставка')`,
        [f.tenantId, f.variantId, day(1), day(5)],
      )
      expect((await ask(c, f, 1, 3)).freeUnits).toBe(0)
    })
  })

  /**
   * ⚠️ Резерв под выдачу с улицы считается от ПОЛНОЙ ёмкости дня,
   * а не от остатка: иначе процент брался бы от уже занятого и
   * придерживал бы меньше обещанного.
   */
  it('резерв под улицу держится и при поимённом учёте', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      await createItems(c, { ...f, count: 10, staffId: f.staffId })
      await poolSays(c, f, 99)

      await c.query(
        `INSERT INTO branch_offline_reserve (tenant_id, branch_id, category_id, mode, value)
         VALUES ($1, $2, $3, 'percent', 20)`,
        [f.tenantId, f.branchId, f.categoryId],
      )

      expect((await ask(c, f, 1, 3)).freeUnits).toBe(8)
    })
  })
})

describe('учёт по количеству: механизм не менялся', () => {
  it('ёмкость берётся из pool_day, единицы не при чём', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c, 'count')
      await poolSays(c, f, 7)

      expect((await ask(c, f, 1, 3)).freeUnits).toBe(7)
    })
  })

  it('занятое в пуле вычитается', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c, 'count')
      await poolSays(c, f, 7)
      await c.query(
        `UPDATE pool_day SET qty_booked = 2 WHERE variant_id = $1`,
        [f.variantId],
      )

      expect((await ask(c, f, 1, 3)).freeUnits).toBe(5)
    })
  })
})

describe('ревизия показывает расхождение счётчика', () => {
  /**
   * ⚠️ Для позиций по количеству `pool_day` остаётся единственным
   * источником, и если он врёт — врёт витрина. Расхождение надо
   * показывать, а не копить: физическое наличие это сумма журнала
   * (железное правило 2), счётчик обязан за ней следовать.
   */
  it('врущий счётчик попадает в ревизию', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c, 'count')
      await c.query(
        `INSERT INTO movement (tenant_id, branch_id, variant_id, kind, qty)
         VALUES ($1, $2, $3, 'receipt', 10)`,
        [f.tenantId, f.branchId, f.variantId],
      )
      await poolSays(c, f, 6)

      const drift = await poolDrift(c, { tenantId: f.tenantId })
      expect(drift).toHaveLength(1)
      expect(drift[0]!.capacity).toBe(6)
      expect(drift[0]!.physical).toBe(10)
      expect(drift[0]!.drift).toBe(-4)
    })
  })

  it('сошедшийся счётчик в ревизию не попадает', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c, 'count')
      await c.query(
        `INSERT INTO movement (tenant_id, branch_id, variant_id, kind, qty)
         VALUES ($1, $2, $3, 'receipt', 6)`,
        [f.tenantId, f.branchId, f.variantId],
      )
      await poolSays(c, f, 6)

      expect(await poolDrift(c, { tenantId: f.tenantId })).toHaveLength(0)
    })
  })

  /** ⚠️ Поимённые позиции не проверяются: там pool_day не читается. */
  it('позиции по единицам в ревизию расхождений не попадают', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c, 'labeled')
      await createItems(c, { ...f, count: 10, staffId: f.staffId })
      await poolSays(c, f, 2)

      expect(await poolDrift(c, { tenantId: f.tenantId })).toHaveLength(0)
    })
  })
})
