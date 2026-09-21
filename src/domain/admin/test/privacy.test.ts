/**
 * Персональные данные: обезличивание, экспорт, удаление (152-ФЗ).
 *
 * ⚠️ Модуль с юридическими последствиями и без тестов. Здесь ошибка
 * не «неудобно», а «нарушение закона»: либо данные живут дольше срока,
 * либо стираются те, что ещё нужны для действующего заказа.
 *
 * ⚠️ Обезличивание и удаление НЕ трогают сами заказы: суммы, даты
 * и позиции — это бухгалтерия проката, а не персональные данные.
 * Стирается связь с человеком, а не история операций.
 */
import { describe, expect, it } from 'vitest'
import { anonymizeExpired, deleteSubjectData, exportSubjectData } from '~/domain/admin/privacy'
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
  const { rows: [st] } = await c.query(
    `INSERT INTO staff (tenant_id, email, name, role, password_hash)
     VALUES ($1, $2, 'Админ', 'admin', 'x') RETURNING id`,
    [t.id, `s-${Date.now()}-${Math.random()}@t.local`],
  )
  return { tenantId: t.id as string, branchId: b.id as string, staffId: st.id as string }
}

async function customer(
  c: import('pg').PoolClient,
  f: { tenantId: string },
  phone: string,
) {
  const { rows: [cu] } = await c.query(
    `INSERT INTO customer (tenant_id, phone, name, email, body_params)
     VALUES ($1, $2, 'Иванов Алексей', 'ivan@example.ru', $3) RETURNING id`,
    [f.tenantId, phone, JSON.stringify({ height: 178, weight: 75 })],
  )
  return cu.id as string
}

/** Заказ с заданным сроком хранения ПД. */
async function order(
  c: import('pg').PoolClient,
  f: { tenantId: string, branchId: string },
  customerId: string,
  retentionUntil: Date | null,
) {
  const from = new Date(Date.now() - 30 * DAY)
  const { rows: [o] } = await c.query(
    `INSERT INTO rental_order
       (tenant_id, branch_pickup_id, customer_id, status, period,
        total_amount, public_code, retention_until)
     VALUES ($1, $2, $3, 'returned', tstzrange($4, $5, '[)'), 5100, $6, $7)
     RETURNING id`,
    [
      f.tenantId, f.branchId, customerId, from, new Date(from.getTime() + DAY),
      `R${Math.floor(Math.random() * 1e6)}`, retentionUntil,
    ],
  )
  return o.id as string
}

async function readCustomer(c: import('pg').PoolClient, id: string) {
  const { rows } = await c.query(
    `SELECT phone, name, email, body_params FROM customer WHERE id = $1`, [id],
  )
  return rows[0]!
}

describe('обезличивание по истечении срока', () => {
  it('стирает личное, когда срок хранения вышел', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const id = await customer(c, f, `+7999${Date.now() % 1_000_000}`)
      await order(c, f, id, new Date(Date.now() - DAY)) // срок истёк вчера

      const r = await anonymizeExpired(c, { limit: 50 })
      expect(r.anonymized).toBeGreaterThan(0)

      const after = await readCustomer(c, id)
      expect(after.name).toBeNull()
      expect(after.email).toBeNull()
      // ⚠️ Мерки — это профиль конкретного человека, стираются тоже.
      expect(after.body_params).toBeNull()
      // ⚠️ Телефон не NULL, а метка: колонка NOT NULL и уникальна,
      // и по метке видно, что запись обезличена, а не пуста по ошибке.
      expect(String(after.phone)).toMatch(/^deleted:/)
    })
  })

  it('⚠️ не трогает клиента с действующим сроком хранения', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const id = await customer(c, f, `+7999${Date.now() % 1_000_000}`)
      await order(c, f, id, new Date(Date.now() + 365 * DAY))

      await anonymizeExpired(c, { limit: 50 })

      const after = await readCustomer(c, id)
      expect(after.name, 'срок ещё идёт — стирать нельзя').toBe('Иванов Алексей')
    })
  })

  it('⚠️ не трогает клиента вообще без заказов', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const id = await customer(c, f, `+7999${Date.now() % 1_000_000}`)

      // Запись создана, заказ ещё оформляется: стереть её сейчас —
      // сломать оформление на середине.
      await anonymizeExpired(c, { limit: 50 })

      expect((await readCustomer(c, id)).name).toBe('Иванов Алексей')
    })
  })

  it('не трогает уже обезличенных повторно', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const id = await customer(c, f, `+7999${Date.now() % 1_000_000}`)
      await order(c, f, id, new Date(Date.now() - DAY))

      await anonymizeExpired(c, { limit: 50 })
      const second = await anonymizeExpired(c, { limit: 50 })

      // Повторный проход воркера не должен считать их заново.
      const { rows } = await c.query<{ phone: string }>(
        `SELECT phone FROM customer WHERE id = $1`, [id],
      )
      expect(rows[0]!.phone).toBe(`deleted:${id}`)
      expect(second.anonymized).toBe(0)
    })
  })

  it('⚠️ история заказа переживает обезличивание', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const id = await customer(c, f, `+7999${Date.now() % 1_000_000}`)
      const orderId = await order(c, f, id, new Date(Date.now() - DAY))

      await anonymizeExpired(c, { limit: 50 })

      // Суммы и даты — бухгалтерия проката, а не персональные данные.
      const { rows } = await c.query<{ total_amount: string, status: string }>(
        `SELECT total_amount, status FROM rental_order WHERE id = $1`, [orderId],
      )
      expect(rows[0]!.status).toBe('returned')
      expect(Number(rows[0]!.total_amount)).toBe(5100)
    })
  })
})

describe('требование субъекта удалить данные', () => {
  it('стирает личное и отзывает согласия', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const phone = `+7999${Date.now() % 1_000_000}`
      const id = await customer(c, f, phone)
      await order(c, f, id, new Date(Date.now() + 365 * DAY))
      await c.query(
        `INSERT INTO consent (tenant_id, customer_id, kind, text_version)
         VALUES ($1, $2, 'save_params', 'v1')`,
        [f.tenantId, id],
      )

      const r = await deleteSubjectData(c, {
        tenantId: f.tenantId, phone, staffId: f.staffId,
      })

      expect(r.deleted).toBe(true)
      expect(r.ordersAffected).toBe(1)
      expect((await readCustomer(c, id)).name).toBeNull()

      // Согласия больше не действуют: мерки не подставятся на стойке.
      const { rows } = await c.query<{ revoked_at: Date | null }>(
        `SELECT revoked_at FROM consent WHERE customer_id = $1`, [id],
      )
      expect(rows[0]!.revoked_at).not.toBeNull()
    })
  })

  it('⚠️ удаление по требованию идёт в audit_log с автором', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const phone = `+7999${Date.now() % 1_000_000}`
      const id = await customer(c, f, phone)
      await order(c, f, id, null)

      await deleteSubjectData(c, {
        tenantId: f.tenantId, phone, staffId: f.staffId, reason: 'заявление от 05.09',
      })

      // Железное правило 13: у действия есть автор и причина.
      const { rows } = await c.query<{ staff_id: string, reason: string }>(
        `SELECT staff_id, reason FROM audit_log
          WHERE target_id = $1 AND action = 'privacy.subject_deleted'`,
        [id],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]!.staff_id).toBe(f.staffId)
      expect(rows[0]!.reason).toBe('заявление от 05.09')
    })
  })

  it('неизвестный телефон — не ошибка, а «нечего удалять»', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const r = await deleteSubjectData(c, {
        tenantId: f.tenantId, phone: '+70000000000', staffId: f.staffId,
      })
      expect(r).toEqual({ deleted: false, ordersAffected: 0 })
    })
  })
})

describe('право на копию своих данных', () => {
  it('экспорт отдаёт данные субъекта', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const phone = `+7999${Date.now() % 1_000_000}`
      const id = await customer(c, f, phone)
      await order(c, f, id, null)

      const dump = await exportSubjectData(c, { tenantId: f.tenantId, phone })

      // 152-ФЗ: субъект вправе получить копию. Пустой ответ на живого
      // клиента был бы отказом в праве.
      expect(dump).toBeTruthy()
      expect(JSON.stringify(dump)).toContain('Иванов Алексей')
    })
  })
})
