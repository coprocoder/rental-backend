/**
 * Напоминания подтвердить бронь (20.4).
 *
 * ⚠️ Обработчик `order.confirm_reminder` и шаблоны на трёх каналах были
 * написаны и зарегистрированы, но в очередь их не ставил никто:
 * инфраструктура работала вхолостую. Эти тесты закрывают именно ту
 * часть, которой не хватало, — выбор кандидатов и постановку в outbox.
 *
 * ⚠️ Идемпотентность здесь не деталь, а суть: воркер крутится раз
 * в 15 секунд, и без ключа клиент получил бы сотню писем за минуту.
 * Защита — уникальный индекс на (tenant_id, idempotency_key) плюс
 * ON CONFLICT DO NOTHING, то есть гарантия БД, а не порядок вызовов.
 */
import { describe, expect, it } from 'vitest'
import { remindUnconfirmed } from '~/domain/platform/reminders'
import { inRollback } from '../../../db/test/setup'

const HOUR = 3600 * 1000

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
    `INSERT INTO customer (tenant_id, phone, name)
     VALUES ($1, $2, 'Клиент') RETURNING id`,
    [t.id, `+7999${Date.now() % 1_000_000}`],
  )
  return { tenantId: t.id as string, branchId: b.id as string, customerId: cu.id as string }
}

/**
 * Заказ, ждущий подтверждения, с дедлайном через `inHours` часов.
 *
 * ⚠️ Даты аренды всегда в будущем: бронь «на сегодня» по правилам
 * жизненного цикла вообще не имеет дедлайна.
 */
async function order(
  c: import('pg').PoolClient,
  f: { tenantId: string, branchId: string, customerId: string },
  inHours: number,
  status = 'awaiting_confirm',
) {
  const deadline = new Date(Date.now() + inHours * HOUR)
  const from = new Date(deadline.getTime() + 24 * HOUR)
  const to = new Date(from.getTime() + 48 * HOUR)
  const { rows: [o] } = await c.query(
    `INSERT INTO rental_order
       (tenant_id, branch_pickup_id, customer_id, status, period,
        confirm_deadline, total_amount, public_code)
     VALUES ($1, $2, $3, $4, tstzrange($5, $6, '[)'), $7, 0, $8)
     RETURNING id`,
    [
      f.tenantId, f.branchId, f.customerId, status, from, to, deadline,
      `R${Math.floor(Math.random() * 1e6)}`,
    ],
  )
  return o.id as string
}

/** Что лежит в outbox по этому заказу. */
async function queued(c: import('pg').PoolClient, orderId: string) {
  const { rows } = await c.query(
    `SELECT kind, idempotency_key, payload FROM outbox
     WHERE kind = 'order.confirm_reminder' AND payload->>'orderId' = $1`,
    [orderId],
  )
  return rows
}

describe('напоминания подтвердить бронь', () => {
  it('ставит напоминание, когда до дедлайна меньше окна', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const id = await order(c, f, 10) // дедлайн через 10 часов — окно 12 ч

      const sent = await remindUnconfirmed(c, { tenantId: f.tenantId })
      expect(sent).toBe(1)

      const rows = await queued(c, id)
      expect(rows).toHaveLength(1)
      expect(rows[0].idempotency_key).toBe(`remind12:${id}`)
      // Токен подтверждения обязан уехать вместе с напоминанием: письмо
      // «подтвердите» без рабочей кнопки бессмысленно. Именно токен,
      // а не ссылка, — базовый адрес знает слой доставки.
      const token = String(rows[0].payload.confirmToken)
      expect(token.length).toBeGreaterThan(20)

      // И он обязан РАБОТАТЬ: выданный при оформлении восстановить
      // нельзя (в базе только хеш), поэтому выписывается новый.
      const { rows: found } = await c.query(
        `SELECT purpose FROM order_token
          WHERE order_id = $1 AND purpose = 'confirm'`,
        [id],
      )
      expect(found.length).toBeGreaterThan(0)
    })
  })

  it('⚠️ дедлайн уходит человеку строкой, а не ISO', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const id = await order(c, f, 10)

      await remindUnconfirmed(c, { tenantId: f.tenantId })
      const [row] = await queued(c, id)

      // В письме этот текст подставляется как есть: «Подтвердите до
      // {{deadline}}». ISO-строка вида 2026-09-05T21:54:40.166Z читается
      // человеком как ошибка системы, а не как срок.
      const d = String(row.payload.deadline)
      expect(d, 'сырой ISO в письме').not.toMatch(/\d{4}-\d{2}-\d{2}T/)
      expect(d, 'часы и минуты на месте').toMatch(/\d{1,2}:\d{2}/)
    })
  })

  it('не напоминает раньше времени', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      // Дедлайн через трое суток: оба окна (48 и 12 часов) ещё далеко.
      const id = await order(c, f, 72)

      expect(await remindUnconfirmed(c, { tenantId: f.tenantId })).toBe(0)
      expect(await queued(c, id)).toHaveLength(0)
    })
  })

  it('⚠️ повторный проход не шлёт второе письмо', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const id = await order(c, f, 10)

      await remindUnconfirmed(c, { tenantId: f.tenantId })
      // Воркер крутится раз в 15 секунд — этот вызов повторяется всегда.
      await remindUnconfirmed(c, { tenantId: f.tenantId })
      await remindUnconfirmed(c, { tenantId: f.tenantId })

      expect(await queued(c, id), 'ровно одно напоминание').toHaveLength(1)
    })
  })

  it('за 48 и за 12 часов — это два разных напоминания', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const id = await order(c, f, 40) // попал в окно 48 ч

      await remindUnconfirmed(c, { tenantId: f.tenantId })
      expect(await queued(c, id)).toHaveLength(1)

      // Время прошло, заказ въехал в ближнее окно: напомнить надо снова,
      // и это не дубль — ключ другой.
      await c.query(
        `UPDATE rental_order SET confirm_deadline = now() + interval '10 hours'
         WHERE id = $1`,
        [id],
      )
      await remindUnconfirmed(c, { tenantId: f.tenantId })

      const rows = await queued(c, id)
      expect(rows).toHaveLength(2)
      expect(rows.map((r) => r.idempotency_key).sort())
        .toEqual([`remind12:${id}`, `remind48:${id}`])
    })
  })

  it('подтверждённый заказ не напоминает о себе', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const id = await order(c, f, 10, 'confirmed')

      expect(await remindUnconfirmed(c, { tenantId: f.tenantId })).toBe(0)
      expect(await queued(c, id)).toHaveLength(0)
    })
  })

  it('просроченному дедлайну напоминание не нужно — его снимает expire', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      // Дедлайн уже в прошлом: этим занимается expireUnconfirmed,
      // а напоминание «подтвердите» опоздало и только путало бы.
      const id = await order(c, f, -1)

      expect(await remindUnconfirmed(c, { tenantId: f.tenantId })).toBe(0)
      expect(await queued(c, id)).toHaveLength(0)
    })
  })
})
