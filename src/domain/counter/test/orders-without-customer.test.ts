/**
 * Список стойки при заказах БЕЗ клиента.
 *
 * ⚠️ ДЕФЕКТ, найденный обходом экранов в браузере: `counter/orders`
 * отдавал 500, стоило снять галочку «только на сегодня». Выдача без
 * брони оформляется без клиента (`customer_id` пуст), `LEFT JOIN`
 * возвращал `null`, а код делал `r.phone.slice(-4)` — падал весь
 * список, а не одна строка.
 *
 * ⚠️ Компилятор этого не ловил, потому что ТИП ЛГАЛ: поле объявлено
 * `phone: string`, хотя join левый. Тип исправлен вместе с кодом —
 * иначе та же ошибка вернулась бы в другом месте.
 *
 * ⚠️ На демо-стенде таких заказов три из 84. Экран стойки — тот, за
 * которым работают весь день.
 */
import { describe, expect, it } from 'vitest'
import { findOrders } from '~/domain/counter/counter'
import { inRollback } from '../../../db/test/setup'

async function fixture(c: import('pg').PoolClient) {
  const { rows: [t] } = await c.query(
    `INSERT INTO tenant (slug, name) VALUES ('t-' || gen_random_uuid(), 'Тест') RETURNING id`,
  )
  const { rows: [b] } = await c.query(
    `INSERT INTO branch (tenant_id, name) VALUES ($1, 'Филиал') RETURNING id`, [t.id],
  )
  return { tenantId: t.id as string, branchId: b.id as string }
}

/** Заказ, оформленный на стойке без записи клиента. */
async function orderWithoutCustomer(
  c: import('pg').PoolClient,
  f: { tenantId: string, branchId: string },
  code: string,
) {
  await c.query(
    `INSERT INTO rental_order
       (tenant_id, branch_pickup_id, customer_id, public_code, status, period, total_amount)
     VALUES ($1, $2, NULL, $3, 'issued',
             tstzrange(now() - interval '2 days', now() - interval '1 day'), '500.00')`,
    [f.tenantId, f.branchId, code],
  )
}

describe('⚠️ заказ без клиента не роняет список стойки', () => {
  it('выдача без брони показывается, телефона просто нет', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      await orderWithoutCustomer(c, f, 'WALK01')

      // ⚠️ `today: false` — именно этот режим и падал: заказ вчерашний,
      // в выборку «только сегодня» он не попадал, и дефект не был виден.
      const rows = await findOrders(c, {
        tenantId: f.tenantId, branchId: f.branchId, today: false,
      })

      expect(rows).toHaveLength(1)
      expect(rows[0]!.publicCode).toBe('WALK01')
      expect(rows[0]!.phoneTail, 'телефона нет — и это нормально').toBeNull()
      expect(rows[0]!.customerName).toBeNull()
    })
  })

  it('заказ с клиентом по-прежнему отдаёт хвост телефона', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const { rows: [cu] } = await c.query(
        `INSERT INTO customer (tenant_id, phone, name)
         VALUES ($1, '+79991234567', 'Иван') RETURNING id`,
        [f.tenantId],
      )
      await c.query(
        `INSERT INTO rental_order
           (tenant_id, branch_pickup_id, customer_id, public_code, status, period, total_amount)
         VALUES ($1, $2, $3, 'WITH01', 'issued',
                 tstzrange(now() - interval '2 days', now() - interval '1 day'), '500.00')`,
        [f.tenantId, f.branchId, cu.id],
      )

      const rows = await findOrders(c, {
        tenantId: f.tenantId, branchId: f.branchId, today: false,
      })

      // ⚠️ Наружу только четыре цифры: полный номер на экране стойки
      // виден очереди за спиной.
      expect(rows[0]!.phoneTail).toBe('4567')
    })
  })

  it('смешанный список отдаётся целиком, а не падает на первом без телефона', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const { rows: [cu] } = await c.query(
        `INSERT INTO customer (tenant_id, phone, name)
         VALUES ($1, '+79990000001', 'Пётр') RETURNING id`,
        [f.tenantId],
      )
      await orderWithoutCustomer(c, f, 'WALK02')
      await c.query(
        `INSERT INTO rental_order
           (tenant_id, branch_pickup_id, customer_id, public_code, status, period, total_amount)
         VALUES ($1, $2, $3, 'WITH02', 'issued',
                 tstzrange(now() - interval '3 days', now() - interval '2 days'), '700.00')`,
        [f.tenantId, f.branchId, cu.id],
      )

      const rows = await findOrders(c, {
        tenantId: f.tenantId, branchId: f.branchId, today: false,
      })

      expect(rows, 'оба заказа в списке').toHaveLength(2)
      expect(rows.map((r) => r.phoneTail).sort()).toEqual(['0001', null])
    })
  })
})
