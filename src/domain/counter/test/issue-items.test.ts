/**
 * Выдача с указанием конкретных вещей.
 *
 * ⚠️ Главное, что здесь закрепляется: указать надо КАЖДУЮ вещь.
 * Выдать «три борда», отметив один номер, значит отправить две вещи
 * в неучтённый оборот — их не потребуют назад, а склад будет считать
 * их на месте. По требованию заказчика это недопустимо.
 *
 * ⚠️ И второе: расщепление строки не меняет сумму заказа. Цена —
 * снимок (правило 6), и если три части не сойдутся с исходной, выдача
 * молча изменит деньги, о которых договорились с клиентом.
 */
import { describe, expect, it } from 'vitest'
import { issueOrder, lookupItemForReturn, returnOrder } from '~/domain/counter/counter'
import { createItems } from '~/domain/inventory/items'
import { inRollback } from '../../../db/test/setup'

async function fixture(
  c: import('pg').PoolClient,
  tracking = 'labeled',
  plan: 'pro' | 'start' = 'pro',
) {
  // ⚠️ Тариф — часть условия: поимённый учёт требует и режима, и
  // оплаченной функции.
  const limits = plan === 'pro'
    ? '{"labeledInventory": true}'
    : '{}'
  const { rows: [p] } = await c.query<{ id: string }>(
    `INSERT INTO plan (code, name, price_per_month, limits)
     VALUES ('p-' || gen_random_uuid(), 'План', 1000, $1::jsonb) RETURNING id`,
    [limits],
  )
  const { rows: [t] } = await c.query(
    `INSERT INTO tenant (slug, name, plan_id, paid_until)
     VALUES ('t-' || gen_random_uuid(), 'Тест', $1, now() + interval '1 year')
     RETURNING id`,
    [p!.id],
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
     VALUES ($1, 's-' || gen_random_uuid() || '@t.local', 'Пётр Стойкин', 'counter')
     RETURNING id`,
    [t.id],
  )
  await c.query(
    `INSERT INTO movement (tenant_id, branch_id, variant_id, kind, qty)
     VALUES ($1, $2, $3, 'receipt', 10)`,
    [t.id, b.id, v.id],
  )
  return { tenantId: t.id, branchId: b.id, categoryId: cat.id, variantId: v.id, staffId: s.id }
}

/** Заказ с одной строкой на `qty` единиц и суммой `amount`. */
async function orderWith(
  c: import('pg').PoolClient,
  f: { tenantId: string, branchId: string, variantId: string },
  qty: number,
  amount: string,
) {
  const { rows: [o] } = await c.query<{ id: string }>(
    `INSERT INTO rental_order (tenant_id, branch_pickup_id, public_code, status, period, total_amount)
     VALUES ($1, $2, 'T-' || substr(gen_random_uuid()::text, 1, 6), 'confirmed',
             tstzrange(now(), now() + interval '2 days'), $3::numeric)
     RETURNING id`,
    [f.tenantId, f.branchId, amount],
  )
  const { rows: [l] } = await c.query<{ id: string }>(
    `INSERT INTO order_line (tenant_id, order_id, variant_id, qty, period, status, amount)
     VALUES ($1, $2, $3, $4, tstzrange(now(), now() + interval '2 days'), 'reserved', $5::numeric)
     RETURNING id`,
    [f.tenantId, o!.id, f.variantId, qty, amount],
  )
  return { orderId: o!.id, lineId: l!.id }
}

async function items(c: import('pg').PoolClient, f: { tenantId: string, variantId: string, staffId: string }, n: number) {
  const { created } = await createItems(c, {
    tenantId: f.tenantId, variantId: f.variantId, count: n, staffId: f.staffId,
  })
  return created
}

describe('выдача по единицам', () => {
  it('каждая вещь получает свою строку с номером', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const its = await items(c, f, 3)
      const { orderId, lineId } = await orderWith(c, f, 3, '3000.00')

      await issueOrder(c, {
        tenantId: f.tenantId, orderId, staffId: f.staffId,
        lines: [{ orderLineId: lineId, qty: 3, itemIds: its.map((i) => i.id) }],
      })

      const { rows } = await c.query<{ n: string, ids: string }>(
        `SELECT count(*)::text AS n, count(item_id)::text AS ids
           FROM order_line WHERE order_id = $1 AND status = 'picked_up'`,
        [orderId],
      )
      expect(rows[0]!.n).toBe('3')
      expect(rows[0]!.ids).toBe('3')
    })
  })

  /**
   * ⚠️ Деньги: 1000.00 на три части даёт 333.34 + 333.33 + 333.33.
   * Остаток кладётся в первую строку — иначе копейка теряется, и сумма
   * заказа перестаёт совпадать с тем, о чём договорились с клиентом.
   */
  it('расщепление не меняет сумму заказа', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const its = await items(c, f, 3)
      const { orderId, lineId } = await orderWith(c, f, 3, '1000.00')

      await issueOrder(c, {
        tenantId: f.tenantId, orderId, staffId: f.staffId,
        lines: [{ orderLineId: lineId, qty: 3, itemIds: its.map((i) => i.id) }],
      })

      const { rows } = await c.query<{ sum: string, parts: string }>(
        `SELECT sum(amount)::text AS sum, count(*)::text AS parts
           FROM order_line WHERE order_id = $1`,
        [orderId],
      )
      expect(rows[0]!.parts).toBe('3')
      expect(Number(rows[0]!.sum)).toBeCloseTo(1000, 2)
    })
  })

  /** ⚠️ Требование заказчика: иначе что-то не вернут, а в базе отметится. */
  it('нельзя выдать три вещи, указав две', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const its = await items(c, f, 3)
      const { orderId, lineId } = await orderWith(c, f, 3, '3000.00')

      await expect(issueOrder(c, {
        tenantId: f.tenantId, orderId, staffId: f.staffId,
        lines: [{ orderLineId: lineId, qty: 3, itemIds: [its[0]!.id, its[1]!.id] }],
      })).rejects.toMatchObject({ statusCode: 422 })
    })
  })

  it('нельзя выдать вообще без указания вещей', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      await items(c, f, 2)
      const { orderId, lineId } = await orderWith(c, f, 1, '1000.00')

      await expect(issueOrder(c, {
        tenantId: f.tenantId, orderId, staffId: f.staffId,
        lines: [{ orderLineId: lineId, qty: 1 }],
      })).rejects.toMatchObject({ statusCode: 422 })
    })
  })

  it('одна вещь дважды в одной выдаче не принимается', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const its = await items(c, f, 2)
      const { orderId, lineId } = await orderWith(c, f, 2, '2000.00')

      await expect(issueOrder(c, {
        tenantId: f.tenantId, orderId, staffId: f.staffId,
        lines: [{ orderLineId: lineId, qty: 2, itemIds: [its[0]!.id, its[0]!.id] }],
      })).rejects.toMatchObject({ statusCode: 422 })
    })
  })

  /** ⚠️ «Отсканировали не ту вещь» — отдельный код, чтобы стойка
      показала разбор, а не «проверьте данные». */
  it('вещь чужой позиции даёт ITEM_MISMATCH', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const { rows: [v2] } = await c.query<{ id: string }>(
        `INSERT INTO inventory_variant (tenant_id, branch_id, category_id, code, name)
         VALUES ($1, $2, $3, 'sb-162', '{"ru":"162 см"}') RETURNING id`,
        [f.tenantId, f.branchId, f.categoryId],
      )
      const alien = await items(c, { ...f, variantId: v2!.id }, 1)
      const { orderId, lineId } = await orderWith(c, f, 1, '1000.00')

      await expect(issueOrder(c, {
        tenantId: f.tenantId, orderId, staffId: f.staffId,
        lines: [{ orderLineId: lineId, qty: 1, itemIds: [alien[0]!.id] }],
      })).rejects.toMatchObject({
        statusCode: 409,
        code: 'ITEM_MISMATCH',
      })
    })
  })

  it('вещь на руках по другому заказу даёт ITEM_BUSY', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const its = await items(c, f, 1)
      const first = await orderWith(c, f, 1, '1000.00')
      await issueOrder(c, {
        tenantId: f.tenantId, orderId: first.orderId, staffId: f.staffId,
        lines: [{ orderLineId: first.lineId, qty: 1, itemIds: [its[0]!.id] }],
      })

      const second = await orderWith(c, f, 1, '1000.00')
      await expect(issueOrder(c, {
        tenantId: f.tenantId, orderId: second.orderId, staffId: f.staffId,
        lines: [{ orderLineId: second.lineId, qty: 1, itemIds: [its[0]!.id] }],
      })).rejects.toMatchObject({
        statusCode: 409,
        code: 'ITEM_BUSY',
      })
    })
  })

  it('движение пишется на каждую вещь — из них строится её история', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const its = await items(c, f, 2)
      const { orderId, lineId } = await orderWith(c, f, 2, '2000.00')

      await issueOrder(c, {
        tenantId: f.tenantId, orderId, staffId: f.staffId,
        lines: [{ orderLineId: lineId, qty: 2, itemIds: its.map((i) => i.id) }],
      })

      const { rows } = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM movement
          WHERE order_id = $1 AND kind = 'issue' AND item_id IS NOT NULL`,
        [orderId],
      )
      expect(rows[0]!.n).toBe('2')
    })
  })
})

describe('выдача по количеству — режим не меняется', () => {
  it('вещи не требуются и строка не расщепляется', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c, 'count')
      const { orderId, lineId } = await orderWith(c, f, 3, '3000.00')

      await issueOrder(c, {
        tenantId: f.tenantId, orderId, staffId: f.staffId,
        lines: [{ orderLineId: lineId, qty: 3 }],
      })

      const { rows } = await c.query<{ n: string, qty: number, ids: string }>(
        `SELECT count(*)::text AS n, max(qty) AS qty, count(item_id)::text AS ids
           FROM order_line WHERE order_id = $1`,
        [orderId],
      )
      expect(rows[0]!.n).toBe('1')
      expect(rows[0]!.qty).toBe(3)
      expect(rows[0]!.ids).toBe('0')
    })
  })
})

describe('приёмка по вещи', () => {
  /**
   * ⚠️ Дефект, найденный сквозной проверкой: движение `return`
   * писалось БЕЗ item_id, и история вещи обрывалась на выдаче —
   * видно, что уехала, и не видно, что вернулась.
   */
  it('возврат пишет движение с номером вещи', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const its = await items(c, f, 1)
      const { orderId, lineId } = await orderWith(c, f, 1, '1000.00')
      await issueOrder(c, {
        tenantId: f.tenantId, orderId, staffId: f.staffId,
        lines: [{ orderLineId: lineId, qty: 1, itemIds: [its[0]!.id] }],
      })

      await returnOrder(c, {
        tenantId: f.tenantId, orderId, staffId: f.staffId,
        lines: [{ orderLineId: lineId, qty: 1, condition: 'ok' }],
      })

      const { rows } = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM movement
          WHERE order_id = $1 AND kind = 'return' AND item_id = $2`,
        [orderId, its[0]!.id],
      )
      expect(rows[0]!.n).toBe('1')
    })
  })

  /** ⚠️ Вещь сама говорит, чей она заказ — искать по телефону не нужно. */
  it('скан находит заказ, в котором вещь на руках', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const its = await items(c, f, 1)
      const { orderId, lineId } = await orderWith(c, f, 1, '1000.00')
      await issueOrder(c, {
        tenantId: f.tenantId, orderId, staffId: f.staffId,
        lines: [{ orderLineId: lineId, qty: 1, itemIds: [its[0]!.id] }],
      })

      const found = await lookupItemForReturn(c, {
        tenantId: f.tenantId, code: its[0]!.labelCode.toLowerCase(),
      })

      expect(found?.state).toBe('issued')
      expect(found?.orderId).toBe(orderId)
      expect(found?.orderLineId).toBe(lineId)
    })
  })

  it('свободная вещь не числится ни за каким заказом', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const its = await items(c, f, 1)

      const found = await lookupItemForReturn(c, {
        tenantId: f.tenantId, code: its[0]!.labelCode,
      })

      expect(found?.state).toBe('free')
      expect(found?.orderId).toBeNull()
    })
  })

  /**
   * ⚠️ Требование заказчика: заказ не закрыт, пока не вернули ВСЁ.
   * Закрыть с невозвращённой вещью значит перестать её ждать.
   */
  it('заказ не закрывается, пока одна вещь не вернулась', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const its = await items(c, f, 2)
      const { orderId, lineId } = await orderWith(c, f, 2, '2000.00')
      await issueOrder(c, {
        tenantId: f.tenantId, orderId, staffId: f.staffId,
        lines: [{ orderLineId: lineId, qty: 2, itemIds: its.map((i) => i.id) }],
      })

      const { rows: lines } = await c.query<{ id: string }>(
        `SELECT id FROM order_line WHERE order_id = $1 ORDER BY id LIMIT 1`,
        [orderId],
      )

      const partial = await returnOrder(c, {
        tenantId: f.tenantId, orderId, staffId: f.staffId,
        lines: [{ orderLineId: lines[0]!.id, qty: 1, condition: 'ok' }],
      })

      expect(partial.allReturned).toBe(false)
      expect(partial.status).toBe('partially_returned')
    })
  })
})

describe('тариф выключает поимённый учёт на стойке', () => {
  /**
   * ⚠️ Понижение тарифа НИЧЕГО не удаляет, поэтому категория остаётся
   * в `labeled` и у проката, который за функцию больше не платит.
   * Требовать у него скан значит остановить стойку на функции,
   * которой у него нет.
   */
  it('на базовом тарифе вещи не требуются, даже если категория labeled', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c, 'labeled', 'start')
      await items(c, f, 2)
      const { orderId, lineId } = await orderWith(c, f, 2, '2000.00')

      await issueOrder(c, {
        tenantId: f.tenantId, orderId, staffId: f.staffId,
        lines: [{ orderLineId: lineId, qty: 2 }],
      })

      const { rows } = await c.query<{ n: string, qty: number }>(
        `SELECT count(*)::text AS n, max(qty) AS qty
           FROM order_line WHERE order_id = $1`,
        [orderId],
      )
      // Строка не расщепилась: работа идёт по количеству.
      expect(rows[0]!.n).toBe('1')
      expect(rows[0]!.qty).toBe(2)
    })
  })
})
