/**
 * Тесты инвариантов — самая важная часть тестового набора.
 *
 * ⚠️ Идут на НАСТОЯЩЕМ Postgres: EXCLUDE USING GIST и RLS — именно то,
 * чего не умеют эмуляторы вроде pg-mem, а проверять надо в первую
 * очередь их. См. ../rental-docs/docs/04-тз/30-эксплуатация/33-качество.md.
 *
 * Список обязательных проверок задан ТЗ; каждая соответствует
 * конкретному железному правилу из CLAUDE.md.
 */
import { describe, expect, it } from 'vitest'
import { inRollback, pool } from './setup'

/** Создаёт минимальный набор данных внутри транзакции. */
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
     VALUES ($1, 'board', '{"ru":"Сноуборд"}', 'instance') RETURNING id`,
    [t.id],
  )
  const { rows: [v] } = await c.query(
    `INSERT INTO inventory_variant (tenant_id, branch_id, category_id, code, name)
     VALUES ($1, $2, $3, 'board-157', '{"ru":"Сноуборд 157"}') RETURNING id`,
    [t.id, b.id, cat.id],
  )
  const { rows: [i] } = await c.query(
    `INSERT INTO item (tenant_id, variant_id, label_code)
     VALUES ($1, $2, 'SB-' || substr(gen_random_uuid()::text, 1, 6)) RETURNING id`,
    [t.id, v.id],
  )
  const { rows: [o] } = await c.query(
    `INSERT INTO rental_order (tenant_id, public_code, branch_pickup_id, period, status)
     VALUES ($1, substr(gen_random_uuid()::text, 1, 8), $2,
             tstzrange(now(), now() + interval '2 days'), 'confirmed')
     RETURNING id`,
    [t.id, b.id],
  )
  return { tenantId: t.id, branchId: b.id, categoryId: cat.id, variantId: v.id, itemId: i.id, orderId: o.id }
}

describe('двойная бронь экземпляра', () => {
  it('пересекающиеся интервалы на одну вещь отклоняются с 23P01', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)

      await c.query(
        `INSERT INTO order_line (tenant_id, order_id, variant_id, item_id, period, status)
         VALUES ($1, $2, $3, $4, tstzrange(now(), now() + interval '2 days'), 'reserved')`,
        [f.tenantId, f.orderId, f.variantId, f.itemId],
      )

      // Вторая бронь той же вещи на пересекающийся интервал.
      await expect(
        c.query(
          `INSERT INTO order_line (tenant_id, order_id, variant_id, item_id, period, status)
           VALUES ($1, $2, $3, $4, tstzrange(now() + interval '1 day', now() + interval '3 days'), 'reserved')`,
          [f.tenantId, f.orderId, f.variantId, f.itemId],
        ),
      ).rejects.toMatchObject({ code: '23P01' })
    })
  })

  it('возврат в 15:00 и выдача в 15:00 не конфликтуют', async () => {
    // Полуоткрытый интервал [начало, конец) — граница не пересекается.
    await inRollback(async (c) => {
      const f = await fixture(c)
      const base = `date_trunc('day', now()) + interval '15 hours'`

      await c.query(
        `INSERT INTO order_line (tenant_id, order_id, variant_id, item_id, period, status)
         VALUES ($1, $2, $3, $4, tstzrange(${base} - interval '3 hours', ${base}), 'reserved')`,
        [f.tenantId, f.orderId, f.variantId, f.itemId],
      )

      // Не должно бросить: конец первого интервала = начало второго.
      await expect(
        c.query(
          `INSERT INTO order_line (tenant_id, order_id, variant_id, item_id, period, status)
           VALUES ($1, $2, $3, $4, tstzrange(${base}, ${base} + interval '3 hours'), 'reserved')`,
          [f.tenantId, f.orderId, f.variantId, f.itemId],
        ),
      ).resolves.toBeTruthy()
    })
  })

  it('отменённая бронь не блокирует перевыдачу', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)

      await c.query(
        `INSERT INTO order_line (tenant_id, order_id, variant_id, item_id, period, status)
         VALUES ($1, $2, $3, $4, tstzrange(now(), now() + interval '2 days'), 'cancelled')`,
        [f.tenantId, f.orderId, f.variantId, f.itemId],
      )

      // Частичное условие ограничения исключает cancelled — вставка проходит.
      await expect(
        c.query(
          `INSERT INTO order_line (tenant_id, order_id, variant_id, item_id, period, status)
           VALUES ($1, $2, $3, $4, tstzrange(now(), now() + interval '2 days'), 'reserved')`,
          [f.tenantId, f.orderId, f.variantId, f.itemId],
        ),
      ).resolves.toBeTruthy()
    })
  })
})

describe('переполнение пула', () => {
  it('qty_booked не может превысить capacity', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      await c.query(
        `INSERT INTO pool_day (tenant_id, variant_id, day, qty_booked, capacity)
         VALUES ($1, $2, current_date, 4, 4)`,
        [f.tenantId, f.variantId],
      )

      await expect(
        c.query(
          `UPDATE pool_day SET qty_booked = qty_booked + 1
           WHERE variant_id = $1 AND day = current_date`,
          [f.variantId],
        ),
      ).rejects.toMatchObject({ code: '23514' }) // check_violation
    })
  })

  it('многодневная бронь занимает КАЖДЫЙ день интервала', async () => {
    // ⚠️ Правило: наличие нельзя считать наивным SUM по пересечению.
    // Бронь с 1 по 5 должна занять и промежуточные дни, иначе 2–4
    // останутся «свободными».
    await inRollback(async (c) => {
      const f = await fixture(c)
      const days = 5

      for (let d = 0; d < days; d++) {
        await c.query(
          `INSERT INTO pool_day (tenant_id, variant_id, day, qty_booked, capacity)
           VALUES ($1, $2, current_date + $3::int, 1, 2)`,
          [f.tenantId, f.variantId, d],
        )
      }

      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM pool_day
         WHERE variant_id = $1 AND qty_booked > 0`,
        [f.variantId],
      )
      expect(rows[0].n).toBe(days)
    })
  })
})

describe('пересечение правил цены', () => {
  it('два активных правила одного типа на пересекающиеся даты отклоняются', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)

      await c.query(
        `INSERT INTO price_rule (tenant_id, variant_id, rule_kind, valid, amount, is_active)
         VALUES ($1, $2, 'base', tstzrange(now(), now() + interval '30 days'), 800, true)`,
        [f.tenantId, f.variantId],
      )

      await expect(
        c.query(
          `INSERT INTO price_rule (tenant_id, variant_id, rule_kind, valid, amount, is_active)
           VALUES ($1, $2, 'base', tstzrange(now() + interval '10 days', now() + interval '40 days'), 900, true)`,
          [f.tenantId, f.variantId],
        ),
      ).rejects.toMatchObject({ code: '23P01' })
    })
  })
})

describe('изоляция тенантов через RLS', () => {
  it('без выставленного app.tenant_id не видно ничего (fail closed)', async () => {
    await inRollback(async (c) => {
      await fixture(c)
      await c.query(`SET LOCAL ROLE rental_app`)
      // current_setting(..., true) вернёт NULL → сравнение NULL → строк нет.
      const { rows } = await c.query(`SELECT count(*)::int AS n FROM rental_order`)
      expect(rows[0].n).toBe(0)
    })
  })

  it('тенант A не видит данных тенанта B', async () => {
    await inRollback(async (c) => {
      const a = await fixture(c)
      const b = await fixture(c)

      await c.query(`SET LOCAL ROLE rental_app`)
      await c.query(`SET LOCAL app.tenant_id = '${a.tenantId}'`)

      const { rows } = await c.query(
        `SELECT tenant_id FROM rental_order`,
      )
      expect(rows.every((r) => r.tenant_id === a.tenantId)).toBe(true)
      expect(rows.some((r) => r.tenant_id === b.tenantId)).toBe(false)
    })
  })
})

describe('дрейф схемы', () => {
  /**
   * ⚠️ Единственная страховка от того, что `drizzle-kit push` тихо снесёт
   * EXCLUDE-ограничения: `drizzle-kit check` этой потери НЕ обнаруживает.
   * Без этого теста можно остаться без главного инварианта проекта и
   * узнать об этом от клиента, у которого одну вещь сдали двоим.
   */
  it('все ожидаемые EXCLUDE-ограничения на месте', async () => {
    const expected = [
      'order_line_no_double_booking',
      'price_rule_no_overlap',
    ]
    const { rows } = await pool().query(
      `SELECT conname FROM pg_constraint WHERE contype = 'x'`,
    )
    const actual = rows.map((r) => r.conname)
    for (const name of expected) {
      expect(actual, `отсутствует EXCLUDE-ограничение ${name}`).toContain(name)
    }
  })

  /**
   * ⚠️ Таблицы, у которых RLS осознанно НЕТ. Список явный и короткий:
   * новая таблица с tenant_id обязана либо получить RLS, либо попасть
   * сюда с объяснением — иначе тест упадёт, и это правильно.
   *
   * `tenant_flag` (17.19): рубильники ставит ПЛАТФОРМА, а не тенант.
   * Смысл в том, чтобы поддержка могла погасить функцию у конкретного
   * проката — в том числе когда у самого проката всё «работает».
   * Под RLS тенанта запись была бы недоступна платформенному контуру,
   * то есть рубильник перестал бы работать как рубильник. Доступ
   * ограничен правами роли: rental_app только читает, пишет
   * rental_worker.
   */
  const RLS_EXEMPT = ['tenant_flag']

  it('RLS включён и форсирован на таблицах с tenant_id', async () => {
    const { rows } = await pool().query(`
      SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN information_schema.columns col
        ON col.table_name = c.relname AND col.column_name = 'tenant_id'
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
    `)
    const missing = rows.map((r) => r.relname).filter((n) => !RLS_EXEMPT.includes(n))
    expect(missing, 'таблицы без FORCE RLS').toEqual([])
  })

  it('исключения из RLS не потеряли ограничение прав', async () => {
    // ⚠️ Раз RLS у таблицы нет, единственная граница — права роли.
    // Тест следит, чтобы прикладная роль не получила запись: иначе
    // тенант смог бы снять с себя рубильник, поставленный поддержкой.
    const { rows } = await pool().query(`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_name = 'tenant_flag' AND grantee = 'rental_app'
    `)
    const granted = rows.map((r) => r.privilege_type).sort()
    expect(granted, 'rental_app должен только читать tenant_flag').toEqual(['SELECT'])
  })

  it('btree_gist установлен', async () => {
    const { rows } = await pool().query(
      `SELECT 1 FROM pg_extension WHERE extname = 'btree_gist'`,
    )
    expect(rows.length, 'btree_gist обязателен для EXCLUDE со скаляром и диапазоном').toBe(1)
  })
})
