/**
 * Жизненный цикл заказа — единственное место, где меняется статус.
 *
 * ⚠️ Самый дорогой модуль без тестов: ошибка здесь либо продаёт вещь
 * дважды (инвентарь не освободился), либо блокирует её навсегда
 * (освободился не тогда). Оба случая видны не сразу и не в логах,
 * а через неделю в виде «наличие врёт».
 *
 * Проверяется четыре обещания:
 *   переходы только по схеме, а не любые;
 *   инвентарь освобождается ровно при выходе из удерживающих статусов;
 *   повторный вызов того же перехода — успех, а не ошибка;
 *   событие пишется в ТОЙ ЖЕ транзакции, что и смена статуса.
 */
import { describe, expect, it } from 'vitest'
import { canTransition, transition, type OrderStatus } from '~/domain/core/order-lifecycle'
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
  const { rows: [st] } = await c.query(
    `INSERT INTO staff (tenant_id, email, name, role, password_hash)
     VALUES ($1, $2, 'Пётр Стойкин', 'counter', 'x') RETURNING id`,
    [t.id, `s-${Date.now()}-${Math.random()}@t.local`],
  )
  return {
    tenantId: t.id as string,
    branchId: b.id as string,
    variantId: v.id as string,
    staffId: st.id as string,
  }
}

/** Заказ в заданном статусе, с одной строкой и занятым пулом. */
async function order(
  c: import('pg').PoolClient,
  f: { tenantId: string, branchId: string, variantId: string },
  status: OrderStatus,
) {
  const from = new Date(Date.now() + 2 * DAY)
  const to = new Date(from.getTime() + 2 * DAY)
  const { rows: [o] } = await c.query(
    `INSERT INTO rental_order
       (tenant_id, branch_pickup_id, status, period, total_amount, public_code)
     VALUES ($1, $2, $3, tstzrange($4, $5, '[)'), 0, $6)
     RETURNING id`,
    [f.tenantId, f.branchId, status, from, to, `R${Math.floor(Math.random() * 1e6)}`],
  )
  await c.query(
    `INSERT INTO order_line (tenant_id, order_id, variant_id, qty, period, status)
     VALUES ($1, $2, $3, 1, tstzrange($4, $5, '[)'), 'reserved')`,
    [f.tenantId, o.id, f.variantId, from, to],
  )

  // Пул занят на каждый день интервала — так его заполняет создание заказа.
  for (let i = 0; i <= 2; i++) {
    const d = new Date(from.getTime() + i * DAY).toISOString().slice(0, 10)
    await c.query(
      `INSERT INTO pool_day (tenant_id, variant_id, day, capacity, qty_booked)
       VALUES ($1, $2, $3::date, 3, 1)
       ON CONFLICT (variant_id, day) DO UPDATE SET qty_booked = pool_day.qty_booked + 1`,
      [f.tenantId, f.variantId, d],
    )
  }
  return o.id as string
}

async function booked(c: import('pg').PoolClient, variantId: string): Promise<number> {
  const { rows } = await c.query<{ s: string }>(
    `SELECT COALESCE(SUM(qty_booked), 0)::text AS s FROM pool_day WHERE variant_id = $1`,
    [variantId],
  )
  return Number(rows[0]!.s)
}

describe('canTransition — схема, а не «куда угодно»', () => {
  it('разрешает шаги по основному пути', () => {
    expect(canTransition('awaiting_confirm', 'confirmed')).toBe(true)
    expect(canTransition('confirmed', 'issued')).toBe(true)
    expect(canTransition('issued', 'returned')).toBe(true)
  })

  it('⚠️ запрещает перескок через выдачу', () => {
    // «Подтверждён → возвращён» означало бы, что вещь вернули, не выдав.
    // Пропущенная выдача — это ненайденная пропажа на складе.
    expect(canTransition('confirmed', 'returned')).toBe(false)
  })

  it('из терминального статуса выхода нет', () => {
    for (const s of ['returned', 'expired', 'cancelled', 'no_show', 'lost'] as OrderStatus[]) {
      expect(canTransition(s, 'confirmed'), `${s} → confirmed`).toBe(false)
      expect(canTransition(s, 'issued'), `${s} → issued`).toBe(false)
    }
  })

  it('выданный заказ нельзя отменить', () => {
    // Вещь физически у клиента: «отменён» скрыл бы это и освободил пул.
    expect(canTransition('issued', 'cancelled')).toBe(false)
  })
})

describe('уведомление о подтверждении', () => {
  it('⚠️ подтверждение ставит письмо в очередь', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const id = await order(c, f, 'awaiting_confirm')

      await transition(c, { orderId: id, to: 'confirmed', actor: { type: 'customer' } })

      // ⚠️ Обработчик order.confirmed и шаблон письма были написаны,
      // но в очередь запись не клал НИКТО: клиент нажимал
      // «Подтвердить» и не получал ничего. Цикл не закрывался.
      const { rows } = await c.query(
        `SELECT payload FROM outbox WHERE tenant_id = $1 AND kind = 'order.confirmed'`,
        [f.tenantId],
      )
      expect(rows.length, 'письмо о подтверждении должно уйти в outbox').toBe(1)
      expect(rows[0]!.payload.orderId).toBe(id)
    })
  })

  it('⚠️ повторное подтверждение не даёт второго письма', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const id = await order(c, f, 'awaiting_confirm')

      // Люди жмут ссылку из письма дважды — это норма, а не ошибка.
      await transition(c, { orderId: id, to: 'confirmed', actor: { type: 'customer' } })
      await transition(c, { orderId: id, to: 'confirmed', actor: { type: 'customer' } })

      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM outbox
          WHERE tenant_id = $1 AND kind = 'order.confirmed'`,
        [f.tenantId],
      )
      expect(rows[0]!.n, 'ключ идемпотентности обязан схлопнуть дубль').toBe(1)
    })
  })

  it('отмена письма о подтверждении не шлёт', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const id = await order(c, f, 'confirmed')

      await transition(c, { orderId: id, to: 'cancelled', actor: { type: 'customer' } })

      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM outbox
          WHERE tenant_id = $1 AND kind = 'order.confirmed'`,
        [f.tenantId],
      )
      expect(rows[0]!.n).toBe(0)
    })
  })
})

describe('переходы и инвентарь', () => {
  it('отмена подтверждённого возвращает инвентарь в пул', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const id = await order(c, f, 'confirmed')
      expect(await booked(c, f.variantId), 'до отмены занято').toBe(3)

      const r = await transition(c, {
        orderId: id, to: 'cancelled', actor: { type: 'customer' },
      })

      expect(r.changed).toBe(true)
      expect(await booked(c, f.variantId), 'после отмены пул свободен').toBe(0)
    })
  })

  it('⚠️ выдача НЕ освобождает инвентарь: вещь у клиента', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const id = await order(c, f, 'confirmed')

      await transition(c, {
        orderId: id, to: 'issued',
        actor: { type: 'staff', staffId: f.staffId, reason: 'выдача' },
      })

      // issued — удерживающий статус: освободить пул значило бы
      // продать вещь, которая физически уехала с клиентом.
      expect(await booked(c, f.variantId)).toBe(3)
    })
  })

  it('⚠️ просрочка тоже удерживает: забронировано и физически отсутствует', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const id = await order(c, f, 'issued')

      await transition(c, {
        orderId: id, to: 'overdue', actor: { type: 'system' },
      })

      expect(await booked(c, f.variantId), 'overdue не освобождает пул').toBe(3)
    })
  })

  it('возврат освобождает пул', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const id = await order(c, f, 'issued')

      await transition(c, {
        orderId: id, to: 'returned',
        actor: { type: 'staff', staffId: f.staffId, reason: 'приём' },
      })

      expect(await booked(c, f.variantId)).toBe(0)
    })
  })

  it('истечение неподтверждённого освобождает пул', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const id = await order(c, f, 'awaiting_confirm')

      await transition(c, { orderId: id, to: 'expired', actor: { type: 'system' } })

      expect(await booked(c, f.variantId), 'иначе арсенал заблокирован навсегда').toBe(0)
    })
  })
})

describe('идемпотентность и отказы', () => {
  it('повторный тот же переход — успех без изменений', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const id = await order(c, f, 'confirmed')

      await transition(c, { orderId: id, to: 'cancelled', actor: { type: 'customer' } })
      const again = await transition(c, {
        orderId: id, to: 'cancelled', actor: { type: 'customer' },
      })

      // ⚠️ changed: false, а не исключение: клиент мог нажать «отменить»
      // дважды или почтовик дёрнул ссылку повторно.
      expect(again.changed).toBe(false)
      // И пул не освобождается ВТОРОЙ раз — иначе счётчик уйдёт в минус.
      expect(await booked(c, f.variantId)).toBe(0)
    })
  })

  it('запрещённый переход отвергается с внятной причиной', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const id = await order(c, f, 'confirmed')

      await expect(
        transition(c, { orderId: id, to: 'returned', actor: { type: 'system' } }),
      ).rejects.toThrow(/нельзя перейти/i)
    })
  })

  it('несуществующий заказ — NOT_FOUND, а не молчание', async () => {
    await inRollback(async (c) => {
      await expect(
        transition(c, {
          orderId: '00000000-0000-0000-0000-000000000000',
          to: 'cancelled',
          actor: { type: 'system' },
        }),
      ).rejects.toThrow(/не найден/i)
    })
  })
})

describe('след в журнале', () => {
  it('событие пишется в той же транзакции, что и статус', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const id = await order(c, f, 'awaiting_confirm')

      await transition(c, {
        orderId: id, to: 'confirmed', actor: { type: 'customer' },
      })

      const { rows } = await c.query(
        `SELECT kind, actor_type, payload FROM event WHERE aggregate_id = $1`,
        [id],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].kind).toBe('order.confirmed')
      expect(rows[0].actor_type).toBe('customer')
      expect(rows[0].payload).toMatchObject({ from: 'awaiting_confirm', to: 'confirmed' })
    })
  })

  it('⚠️ ручное вмешательство попадает в audit_log с автором и причиной', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const id = await order(c, f, 'confirmed')

      await transition(c, {
        orderId: id, to: 'no_show',
        actor: { type: 'staff', staffId: f.staffId, reason: 'не пришёл за два часа' },
      })

      // Железное правило 13: у каждого ручного действия автор и причина.
      const { rows } = await c.query(
        `SELECT action, staff_id, reason FROM audit_log WHERE target_id = $1`,
        [id],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].staff_id).toBe(f.staffId)
      expect(rows[0].reason).toBe('не пришёл за два часа')
    })
  })

  it('автоматика в audit_log не пишется — там только люди', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const id = await order(c, f, 'awaiting_confirm')

      await transition(c, { orderId: id, to: 'expired', actor: { type: 'system' } })

      const { rows } = await c.query(
        `SELECT 1 FROM audit_log WHERE target_id = $1`, [id],
      )
      expect(rows, 'снятие по дедлайну — не ручное вмешательство').toHaveLength(0)
    })
  })

  it('возвращает заказ с УЖЕ обновлённым статусом', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const id = await order(c, f, 'confirmed')

      const r = await transition(c, {
        orderId: id, to: 'issued',
        actor: { type: 'staff', staffId: f.staffId, reason: 'выдача' },
      })

      // ⚠️ Строка читалась ДО update: без явной подмены стойка после
      // выдачи показывала бы «подтверждён» вместо «выдан».
      expect(r.order.status).toBe('issued')
      expect(r.from).toBe('confirmed')
    })
  })
})
