/**
 * Обслуживание: список работ техника и возврат в оборот.
 *
 * ⚠️ Экран техника закрывает настоящий дефект: вещь уходила в
 * обслуживание и не могла вернуться — `returnFromService` была
 * написана и никем не вызывалась. Эти тесты закрепляют обратный путь
 * и то, что при поимённом учёте он идёт по КОНКРЕТНОЙ вещи.
 */
import { describe, expect, it } from 'vitest'
import { finishService, itemHistory, serviceTasks } from '~/domain/service/service'
import { createItems } from '~/domain/inventory/items'
import { inRollback } from '../../../db/test/setup'

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
     VALUES ($1, $2, $3, 'sb-157', '{"ru":"157 см"}') RETURNING id`,
    [t.id, b.id, cat.id],
  )
  const { rows: [s] } = await c.query(
    `INSERT INTO staff (tenant_id, email, name, role)
     VALUES ($1, 'o-' || gen_random_uuid() || '@t.local', 'Пётр Техников', 'technician')
     RETURNING id`,
    [t.id],
  )
  return { tenantId: t.id, branchId: b.id, categoryId: cat.id, variantId: v.id, staffId: s.id }
}

/** Отправляет вещь в обслуживание — так же, как это делает стойка. */
async function toService(
  c: import('pg').PoolClient,
  f: { tenantId: string, branchId: string, variantId: string, staffId: string },
  opts: { itemId?: string, kind?: string, qty?: number } = {},
) {
  await c.query(
    `INSERT INTO movement
       (tenant_id, branch_id, variant_id, item_id, kind, qty, staff_id, service_kind, reason)
     VALUES ($1, $2, $3, $4, 'to_service', $5, $6, $7::service_kind, 'после возврата')`,
    [f.tenantId, f.branchId, f.variantId, opts.itemId ?? null,
     -(opts.qty ?? 1), f.staffId, opts.kind ?? 'repair'],
  )
}

describe('список работ по количеству', () => {
  it('показывает, сколько единиц в обслуживании', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      await toService(c, f, { qty: 2 })

      const tasks = await serviceTasks(c, { tenantId: f.tenantId })
      expect(tasks).toHaveLength(1)
      expect(tasks[0]!.qty).toBe(2)
      expect(tasks[0]!.itemId).toBeNull()
      expect(tasks[0]!.labelCode).toBeNull()
      expect(tasks[0]!.serviceKind).toBe('repair')
    })
  })

  it('возврат в оборот убирает позицию из списка', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      await toService(c, f, { qty: 1 })

      const r = await finishService(c, {
        tenantId: f.tenantId, branchId: f.branchId,
        variantId: f.variantId, qty: 1, staffId: f.staffId,
      })

      expect(r.returned).toBe(1)
      expect(await serviceTasks(c, { tenantId: f.tenantId })).toHaveLength(0)
    })
  })

  /** ⚠️ Вернуть больше, чем уходило, значит создать вещи из воздуха. */
  it('нельзя вернуть больше, чем в обслуживании', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      await toService(c, f, { qty: 1 })

      const r = await finishService(c, {
        tenantId: f.tenantId, branchId: f.branchId,
        variantId: f.variantId, qty: 99, staffId: f.staffId,
      })

      expect(r.returned).toBe(1)
    })
  })
})

describe('список работ по единицам', () => {
  async function labeled(c: import('pg').PoolClient) {
    const f = await fixture(c, 'labeled')
    const { created } = await createItems(c, {
      tenantId: f.tenantId, variantId: f.variantId, count: 3, staffId: f.staffId,
    })
    return { ...f, items: created }
  }

  /**
   * ⚠️ Главное отличие этапа: каждая вещь — своя строка. Без
   * группировки по item_id номера схлопнулись бы в «3 шт», и техник
   * снова не знал бы, какую вещь брать со стеллажа.
   */
  it('каждая вещь — отдельная строка с номером', async () => {
    await inRollback(async (c) => {
      const f = await labeled(c)
      await toService(c, f, { itemId: f.items[0]!.id, kind: 'repair' })
      await toService(c, f, { itemId: f.items[1]!.id, kind: 'wax' })

      const tasks = await serviceTasks(c, { tenantId: f.tenantId })
      expect(tasks).toHaveLength(2)
      expect(tasks.map((t) => t.labelCode).sort()).toEqual(['BO-0001', 'BO-0002'])
      expect(tasks.map((t) => t.serviceKind).sort()).toEqual(['repair', 'wax'])
      expect(tasks.every((t) => t.qty === 1)).toBe(true)
    })
  })

  /**
   * ⚠️ Тот самый разрыв, который ломал бы учёт: без фильтра по
   * item_id «вернуть одну» списывало бы её с общего счётчика позиции,
   * и помеченная вещь осталась бы в обслуживании навсегда.
   */
  it('возврат конкретной вещи не трогает остальные', async () => {
    await inRollback(async (c) => {
      const f = await labeled(c)
      await toService(c, f, { itemId: f.items[0]!.id })
      await toService(c, f, { itemId: f.items[1]!.id })

      await finishService(c, {
        tenantId: f.tenantId, branchId: f.branchId, variantId: f.variantId,
        itemId: f.items[0]!.id, qty: 1, staffId: f.staffId,
      })

      const left = await serviceTasks(c, { tenantId: f.tenantId })
      expect(left).toHaveLength(1)
      expect(left[0]!.labelCode).toBe('BO-0002')
    })
  })

  it('дважды вернуть одну вещь нельзя', async () => {
    await inRollback(async (c) => {
      const f = await labeled(c)
      await toService(c, f, { itemId: f.items[0]!.id })

      const first = await finishService(c, {
        tenantId: f.tenantId, branchId: f.branchId, variantId: f.variantId,
        itemId: f.items[0]!.id, qty: 1, staffId: f.staffId,
      })
      const second = await finishService(c, {
        tenantId: f.tenantId, branchId: f.branchId, variantId: f.variantId,
        itemId: f.items[0]!.id, qty: 1, staffId: f.staffId,
      })

      expect(first.returned).toBe(1)
      expect(second.returned).toBe(0)
    })
  })
})

describe('история вещи', () => {
  /**
   * ⚠️ Ровно то, что спека числила потерей количественного учёта:
   * «теряется история „эта пара уже трижды ломалась"».
   */
  it('показывает, что с вещью делали, и кто', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c, 'labeled')
      const { created } = await createItems(c, {
        tenantId: f.tenantId, variantId: f.variantId, count: 1, staffId: f.staffId,
      })
      const item = created[0]!

      await toService(c, f, { itemId: item.id, kind: 'repair' })
      await finishService(c, {
        tenantId: f.tenantId, branchId: f.branchId, variantId: f.variantId,
        itemId: item.id, qty: 1, staffId: f.staffId, note: 'заменил крепление',
      })

      const history = await itemHistory(c, { tenantId: f.tenantId, itemId: item.id })
      expect(history).toHaveLength(2)
      // Новое сверху: техника интересует последнее, а не первое.
      expect(history[0]!.kind).toBe('from_service')
      expect(history[0]!.reason).toBe('заменил крепление')
      expect(history[0]!.staffName).toBe('Пётр Техников')
      expect(history[1]!.kind).toBe('to_service')
      expect(history[1]!.serviceKind).toBe('repair')
    })
  })
})
