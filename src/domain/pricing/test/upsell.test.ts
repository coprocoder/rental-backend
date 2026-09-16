/**
 * Допродажа на стойке (17.21).
 *
 * Проверяются три ограничения ТЗ, потому что каждое из них легко
 * потерять при доработке:
 *   — не более трёх;
 *   — только по опубликованному прайсу;
 *   — цена считается сервером, а не приходит с клиента.
 */
import { describe, expect, it } from 'vitest'
import { inRollback } from '../../../db/test/setup'
import { upsellFor, addUpsellLine, UPSELL_LIMIT } from '~/domain/pricing/upsell'

/** Прокат, филиал, заказ и набор мелочи с ценой. */
async function fixture(
  c: import('pg').PoolClient,
  opts: { extras: number, priced?: boolean },
) {
  const { rows: [t] } = await c.query(
    `INSERT INTO tenant (slug, name, day_mode)
     VALUES ('t-' || gen_random_uuid(), 'Тест', 'calendar') RETURNING id`,
  )
  const { rows: [b] } = await c.query(
    `INSERT INTO branch (tenant_id, name, timezone)
     VALUES ($1, 'Филиал', 'Asia/Krasnoyarsk') RETURNING id`,
    [t.id],
  )
  const { rows: [board] } = await c.query(
    `INSERT INTO category (tenant_id, code, name, tracking)
     VALUES ($1, 'board', '{"ru":"Сноуборд"}', 'count') RETURNING id`,
    [t.id],
  )
  // ⚠️ Каждая мелочь — СВОЯ категория: движок предлагает по одной
  // позиции на категорию (клиенту нужен шлем, а не выбор между M и L),
  // и восемь вариантов в одной категории дали бы одну строку вместо
  // трёх. Так же устроены и настоящие данные.
  const gearIds: string[] = []
  for (let g = 0; g < opts.extras; g++) {
    const { rows: [cat] } = await c.query(
      `INSERT INTO category (tenant_id, code, name, tracking)
       VALUES ($1, $2, $3, 'count') RETURNING id`,
      [t.id, `gear-${g}`, JSON.stringify({ ru: `Мелочь ${g}` })],
    )
    gearIds.push(cat.id)
  }
  const { rows: [bv] } = await c.query(
    `INSERT INTO inventory_variant (tenant_id, branch_id, category_id, code, name)
     VALUES ($1, $2, $3, 'board-157', '{"ru":"Сноуборд 157"}') RETURNING id`,
    [t.id, b.id, board.id],
  )

  const from = new Date(Date.now() + 2 * 86_400_000)
  const to = new Date(Date.now() + 4 * 86_400_000)

  const { rows: [o] } = await c.query(
    `INSERT INTO rental_order (tenant_id, public_code, branch_pickup_id, period, status, total_amount)
     VALUES ($1, substr(gen_random_uuid()::text, 1, 8), $2, tstzrange($3, $4), 'confirmed', 5000)
     RETURNING id`,
    [t.id, b.id, from, to],
  )
  await c.query(
    `INSERT INTO order_line (tenant_id, order_id, variant_id, qty, period, amount)
     VALUES ($1, $2, $3, 1, tstzrange($4, $5), 5000)`,
    [t.id, o.id, bv.id, from, to],
  )

  // Мелочь: несколько вариантов, каждый со свободной ёмкостью.
  const extras: string[] = []
  for (let n = 0; n < opts.extras; n++) {
    const { rows: [v] } = await c.query(
      `INSERT INTO inventory_variant (tenant_id, branch_id, category_id, code, name)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [t.id, b.id, gearIds[n], `gear-${n}`, JSON.stringify({ ru: `Мелочь ${n}` })],
    )
    extras.push(v.id)

    for (let d = -1; d <= 6; d++) {
      const day = new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10)
      await c.query(
        `INSERT INTO pool_day (tenant_id, variant_id, day, capacity, qty_booked)
         VALUES ($1, $2, $3, 5, 0) ON CONFLICT DO NOTHING`,
        [t.id, v.id, day],
      )
    }

    // ⚠️ Прайс — отдельно от наличия: тест «без цены» проверяет
    // именно отсутствие правила, а не отсутствие вещи.
    if (opts.priced !== false) {
      await c.query(
        `INSERT INTO price_rule (tenant_id, variant_id, rule_kind, valid, amount)
         VALUES ($1, $2, 'base', tstzrange(now() - interval '30 days', now() + interval '365 days'),
                 200)`,
        [t.id, v.id],
      )
    }
  }

  return { tenantId: t.id, branchId: b.id, orderId: o.id, boardVariantId: bv.id, extras, from, to }
}

const CFG = { dayMode: 'calendar' as const, timezone: 'Asia/Krasnoyarsk' }

describe('допродажа на стойке', () => {
  it('предлагает не более трёх, даже когда подходящих больше', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c, { extras: 8 })
      const items = await upsellFor(c, {
        tenantId: f.tenantId, orderId: f.orderId, branchId: f.branchId, ...CFG,
      })
      expect(items.length).toBeLessThanOrEqual(UPSELL_LIMIT)
      expect(items.length).toBe(3)
    })
  })

  it('позиция без действующей цены не предлагается', async () => {
    await inRollback(async (c) => {
      // ⚠️ Вещь есть и свободна, но правила цены на неё нет.
      // «Договоритесь на месте» — ровно то, чего система не делает.
      const f = await fixture(c, { extras: 5, priced: false })
      const items = await upsellFor(c, {
        tenantId: f.tenantId, orderId: f.orderId, branchId: f.branchId, ...CFG,
      })
      expect(items).toEqual([])
    })
  })

  it('уже выданному заказу не предлагает ничего', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c, { extras: 5 })
      await c.query(`UPDATE rental_order SET status = 'issued' WHERE id = $1`, [f.orderId])
      const items = await upsellFor(c, {
        tenantId: f.tenantId, orderId: f.orderId, branchId: f.branchId, ...CFG,
      })
      expect(items).toEqual([])
    })
  })

  it('то, что уже в заказе, второй раз не предлагается', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c, { extras: 5 })
      const before = await upsellFor(c, {
        tenantId: f.tenantId, orderId: f.orderId, branchId: f.branchId, ...CFG,
      })
      await addUpsellLine(c, {
        tenantId: f.tenantId, orderId: f.orderId,
        variantId: before[0]!.variantId, qty: 1,
        staffId: f.tenantId, ...CFG,
      })
      const after = await upsellFor(c, {
        tenantId: f.tenantId, orderId: f.orderId, branchId: f.branchId, ...CFG,
      })
      expect(after.map((i) => i.variantId)).not.toContain(before[0]!.variantId)
    })
  })

  it('сумма заказа растёт на серверную цену, снимок дополняется', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c, { extras: 3 })
      const items = await upsellFor(c, {
        tenantId: f.tenantId, orderId: f.orderId, branchId: f.branchId, ...CFG,
      })
      const pick = items[0]!

      const res = await addUpsellLine(c, {
        tenantId: f.tenantId, orderId: f.orderId,
        variantId: pick.variantId, qty: 1,
        staffId: f.tenantId, ...CFG,
      })

      // Цена берётся из прайса, а не откуда-либо ещё.
      expect(res.amount).toBe(pick.amount)
      expect(Number(res.total)).toBe(5000 + Number(pick.amount))

      const { rows } = await c.query(
        `SELECT jsonb_array_length(price_breakdown->'breakdown') AS n
         FROM rental_order WHERE id = $1`,
        [f.orderId],
      )
      expect(Number(rows[0]!.n)).toBe(1)
    })
  })

  it('категория, уже представленная в заказе, не предлагается', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c, { extras: 3 })
      // Добавляем в заказ вторую строку из категории первой мелочи.
      const { rows: [v] } = await c.query(
        `SELECT category_id FROM inventory_variant WHERE id = $1`, [f.extras[0]],
      )
      await c.query(
        `INSERT INTO order_line (tenant_id, order_id, variant_id, qty, period, amount)
         VALUES ($1, $2, $3, 1, tstzrange($4, $5), 100)`,
        [f.tenantId, f.orderId, f.extras[0], f.from, f.to],
      )
      const items = await upsellFor(c, {
        tenantId: f.tenantId, orderId: f.orderId, branchId: f.branchId, ...CFG,
      })
      // ⚠️ Исключается вся КАТЕГОРИЯ, а не только взятый вариант:
      // тому, кто взял сноуборд 157, не предлагают сноуборд 147.
      const { rows: sameCat } = await c.query<{ id: string }>(
        `SELECT id FROM inventory_variant WHERE category_id = $1`, [v.category_id],
      )
      const excluded = new Set(sameCat.map((r) => r.id))
      expect(items.every((i) => !excluded.has(i.variantId))).toBe(true)
    })
  })

  it('позиция дороже половины заказа не предлагается', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c, { extras: 3 })
      // Заказ дешевле, чем мелочь: допродажа дороже самой аренды —
      // это выглядит как неисправность, а не как предложение.
      await c.query(`UPDATE rental_order SET total_amount = 100 WHERE id = $1`, [f.orderId])
      const items = await upsellFor(c, {
        tenantId: f.tenantId, orderId: f.orderId, branchId: f.branchId, ...CFG,
      })
      expect(items).toEqual([])
    })
  })

  it('несезонная категория не предлагается', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c, { extras: 3 })
      // Все мелочи объявляем строго летними, а заказ идёт зимой.
      await c.query(
        `UPDATE category SET season_from_month = 6, season_to_month = 8
         WHERE tenant_id = $1 AND code LIKE 'gear-%'`,
        [f.tenantId],
      )
      await c.query(
        `UPDATE rental_order
         SET period = tstzrange(now() + interval '120 days', now() + interval '122 days')
         WHERE id = $1`,
        [f.orderId],
      )
      const items = await upsellFor(c, {
        tenantId: f.tenantId, orderId: f.orderId, branchId: f.branchId, ...CFG,
      })
      // ⚠️ Даже если дата попадёт в лето — тест проверяет, что фильтр
      // ВООБЩЕ применяется: иначе к сапборду летом шли бы горные ботинки.
      const { rows } = await c.query<{ m: string }>(
        `SELECT EXTRACT(MONTH FROM lower(period))::text AS m
         FROM rental_order WHERE id = $1`, [f.orderId],
      )
      const month = Number(rows[0]!.m)
      const inSeason = month >= 6 && month <= 8
      expect(items.length === 0).toBe(!inSeason)
    })
  })

  it('в выданный заказ допродать нельзя', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c, { extras: 3 })
      const items = await upsellFor(c, {
        tenantId: f.tenantId, orderId: f.orderId, branchId: f.branchId, ...CFG,
      })
      const pick = items[0]!
      await c.query(`UPDATE rental_order SET status = 'issued' WHERE id = $1`, [f.orderId])
      await expect(addUpsellLine(c, {
        tenantId: f.tenantId, orderId: f.orderId,
        variantId: pick.variantId, qty: 1,
        staffId: f.tenantId, ...CFG,
      })).rejects.toThrow()
    })
  })
})
