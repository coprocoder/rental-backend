/**
 * Узнавание повторного клиента на стойке (24-смена-и-ревизия.md).
 *
 * ⚠️ Не скидки и не приоритет — это запрещено публичным договором.
 * Только скорость и точность: выдача из 10 секунд превращается в 5,
 * потому что не нужно заново измерять и подбирать.
 *
 * ⚠️ Главная граница — СОГЛАСИЕ. Параметры тела подставляются только
 * при действующем `save_params`. Без него история отдаёт всё остальное,
 * а мерки — нет: это персональные данные, и отсутствие галочки значит
 * «нельзя», а не «забыли спросить».
 *
 * ⚠️ Эти тесты появились потому, что путь не был проверен ни разу:
 * в сиде нет ни одного клиента с таким согласием, и живой вызов
 * стойки возвращал bodyParams: null, что выглядело как дефект, хотя
 * было правильным поведением при отсутствии согласия.
 */
import { describe, expect, it } from 'vitest'
import { historyForOrder } from '~/domain/orders/customer-history'
import { inRollback } from '../../../db/test/setup'

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
  const { rows: [cu] } = await c.query(
    `INSERT INTO customer (tenant_id, phone, name, body_params)
     VALUES ($1, $2, 'Иванов Алексей', $3) RETURNING id`,
    [t.id, `+7999${Date.now() % 1_000_000}`, JSON.stringify({ height: 178, weight: 75 })],
  )
  return { tenantId: t.id as string, branchId: b.id as string, customerId: cu.id as string }
}

async function order(
  c: import('pg').PoolClient,
  f: { tenantId: string, branchId: string, customerId: string },
) {
  const from = new Date(Date.now() + DAY)
  const { rows: [o] } = await c.query(
    `INSERT INTO rental_order
       (tenant_id, branch_pickup_id, customer_id, status, period, total_amount, public_code)
     VALUES ($1, $2, $3, 'confirmed', tstzrange($4, $5, '[)'), 0, $6)
     RETURNING id`,
    [
      f.tenantId, f.branchId, f.customerId, from, new Date(from.getTime() + DAY),
      `R${Math.floor(Math.random() * 1e6)}`,
    ],
  )
  return o.id as string
}

async function giveConsent(c: import('pg').PoolClient, f: { tenantId: string, customerId: string }) {
  await c.query(
    `INSERT INTO consent (tenant_id, customer_id, kind, text_version)
     VALUES ($1, $2, 'save_params', 'v1')`,
    [f.tenantId, f.customerId],
  )
}

describe('история клиента на выдаче', () => {
  it('без согласия мерки не отдаются, даже когда они сохранены', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const id = await order(c, f)

      const h = await historyForOrder(c, {
        tenantId: f.tenantId, orderId: id, branchIds: [],
      })
      expect(h).not.toBeNull()
      expect(h!.bodyParams, 'мерки без согласия').toBeNull()
    })
  })

  it('с согласием мерки подставляются — ради этого всё и делалось', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const id = await order(c, f)
      await giveConsent(c, f)

      const h = await historyForOrder(c, {
        tenantId: f.tenantId, orderId: id, branchIds: [],
      })
      expect(h!.bodyParams).toEqual({ height: 178, weight: 75 })
    })
  })

  it('⚠️ отозванное согласие снова закрывает мерки', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const id = await order(c, f)
      await giveConsent(c, f)
      // Клиент передумал: отзыв обязан действовать сразу, а не
      // «начиная со следующего заказа».
      await c.query(
        `UPDATE consent SET revoked_at = now()
         WHERE customer_id = $1 AND kind = 'save_params'`,
        [f.customerId],
      )

      const h = await historyForOrder(c, {
        tenantId: f.tenantId, orderId: id, branchIds: [],
      })
      expect(h!.bodyParams).toBeNull()
    })
  })

  it('заказ без клиента истории не имеет', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const from = new Date(Date.now() + DAY)
      const { rows: [o] } = await c.query(
        `INSERT INTO rental_order
           (tenant_id, branch_pickup_id, status, period, total_amount, public_code)
         VALUES ($1, $2, 'confirmed', tstzrange($3, $4, '[)'), 0, $5)
         RETURNING id`,
        [f.tenantId, f.branchId, from, new Date(from.getTime() + DAY), `R${Date.now() % 1e6}`],
      )

      // Выдача с улицы: клиента в системе может не быть вовсе,
      // и это нормальный случай, а не ошибка.
      expect(await historyForOrder(c, {
        tenantId: f.tenantId, orderId: o.id, branchIds: [],
      })).toBeNull()
    })
  })

  it('история ограничена филиалами сотрудника', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const id = await order(c, f)

      // Сотруднику доступен ДРУГОЙ филиал: заказы этого он считать
      // не должен — иначе стойка одной точки видит, что клиент брал
      // в другом городе.
      const { rows: [other] } = await c.query(
        `INSERT INTO branch (tenant_id, name) VALUES ($1, 'Чужой') RETURNING id`,
        [f.tenantId],
      )
      const h = await historyForOrder(c, {
        tenantId: f.tenantId, orderId: id, branchIds: [other.id],
      })
      expect(h!.rentalCount).toBe(0)
    })
  })
})

describe('первая аренда — не «клиент уже брал»', () => {
  it('у нового клиента счётчик аренд нулевой', async () => {
    // ⚠️ Найдено сквозным прогоном: стойка показывала «Клиент уже брал.
    // Аренда номер 0» человеку, который пришёл впервые. История есть
    // всегда — это объект с нулями, а не null, — поэтому решать
    // «показывать ли блок» по самому факту её наличия нельзя.
    // Признак повторного клиента — rentalCount > 0, и ничто иное.
    await inRollback(async (c) => {
      const f = await fixture(c)
      const id = await order(c, f)

      const h = await historyForOrder(c, {
        tenantId: f.tenantId, orderId: id, branchIds: [],
      })
      expect(h, 'история возвращается и для новичка').not.toBeNull()
      expect(h!.rentalCount, 'аренд ещё не было').toBe(0)
      expect(h!.previousItems).toHaveLength(0)
      expect(h!.lastDin).toBeNull()
    })
  })
})
