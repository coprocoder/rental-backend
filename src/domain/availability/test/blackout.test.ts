/**
 * Точечное отключение позиции на даты (18.2).
 *
 * ⚠️ Прямая жалоба на Twice Commerce: «невозможно полностью отключить
 * товар на определённые дни». Сезонность категории и расписание филиала
 * этого не закрывают — они про КАТЕГОРИЮ и про ФИЛИАЛ, а выключить
 * нужно один вариант на конкретные даты: сноуборд уехал на выставку,
 * ботинки в ремонте до пятницы.
 *
 * ⚠️ Отключение НЕ трогает счётчики пула. Это отдельная ось: пул
 * говорит «сколько физически есть», отключение — «не продавать».
 * Смешивать их нельзя, иначе снятие отключения потеряет реальные
 * брони, которые в эти дни уже стоят.
 */
import { describe, expect, it } from 'vitest'
import { checkAvailability } from '~/domain/availability/availability'
import { blackoutVariant, clearBlackout } from '~/domain/availability/blackout'
import { inRollback } from '../../../db/test/setup'

const TZ = 'Asia/Krasnoyarsk'
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
  return { tenantId: t.id as string, branchId: b.id as string, variantId: v.id as string }
}

/** Наполняет pool_day так, чтобы позиция была доступна. */
async function stock(
  c: import('pg').PoolClient,
  f: { tenantId: string, branchId: string, variantId: string },
  days: string[],
  capacity = 3,
) {
  for (const d of days) {
    await c.query(
      `INSERT INTO pool_day (tenant_id, variant_id, day, capacity, qty_booked)
       VALUES ($1, $2, $3::date, $4, 0)
       ON CONFLICT (variant_id, day) DO UPDATE SET capacity = excluded.capacity`,
      [f.tenantId, f.variantId, d, capacity],
    )
  }
}

/**
 * Календарные дни интервала В ПОЯСЕ ФИЛИАЛА.
 *
 * ⚠️ Было `toISOString().slice(0, 10)` — то есть день по UTC, тогда как
 * наличие считается по поясу филиала (+7). После 17:00 UTC даты
 * расходились на сутки: в пул клались 11–13 сентября, а спрашивались
 * 12–14, четырнадцатого в пуле не было, и «свободно» отвечало false.
 * Тест был зелёным утром и красным вечером — то самое расхождение
 * UTC и пояса филиала, ради которого в проекте и заведено правило
 * «момент времени собирает сервер по поясу филиала».
 */
function isoDays(from: Date, count: number): string[] {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ })
  return Array.from({ length: count }, (_, i) =>
    fmt.format(new Date(from.getTime() + i * DAY)))
}

describe('отключение позиции на даты', () => {
  it('отключённый день делает позицию недоступной', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const from = new Date(Date.now() + 2 * DAY)
      const to = new Date(from.getTime() + 2 * DAY)
      const days = isoDays(from, 3)
      await stock(c, f, days)

      // До отключения — свободно.
      const before = await checkAvailability(c, {
        tenantId: f.tenantId, variantId: f.variantId, from, to, timezone: TZ,
      })
      expect(before.available).toBe(true)

      await blackoutVariant(c, {
        tenantId: f.tenantId,
        variantId: f.variantId,
        from: days[1]!,
        to: days[1]!,
        reason: 'уехал на выставку',
      })

      const after = await checkAvailability(c, {
        tenantId: f.tenantId, variantId: f.variantId, from, to, timezone: TZ,
      })
      expect(after.available, 'позиция отключена на середину периода').toBe(false)
      expect(after.shortageDays).toContain(days[1])
    })
  })

  it('соседние дни не задеты', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const from = new Date(Date.now() + 2 * DAY)
      const days = isoDays(from, 4)
      await stock(c, f, days)

      await blackoutVariant(c, {
        tenantId: f.tenantId, variantId: f.variantId,
        from: days[2]!, to: days[2]!, reason: 'ремонт',
      })

      // Период целиком ДО отключённого дня — по-прежнему доступен.
      const ok = await checkAvailability(c, {
        tenantId: f.tenantId,
        variantId: f.variantId,
        from,
        to: new Date(from.getTime() + DAY),
        timezone: TZ,
      })
      expect(ok.available).toBe(true)
    })
  })

  it('⚠️ отключение не трогает счётчики пула', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const from = new Date(Date.now() + 2 * DAY)
      const days = isoDays(from, 2)
      await stock(c, f, days)

      await blackoutVariant(c, {
        tenantId: f.tenantId, variantId: f.variantId,
        from: days[0]!, to: days[0]!, reason: 'ремонт',
      })

      // Ёмкость и брони остались как были: отключение — отдельная ось,
      // и снятие его обязано вернуть ровно прежнюю картину.
      const { rows } = await c.query(
        `SELECT capacity, qty_booked FROM pool_day
         WHERE variant_id = $1 AND day = $2::date`,
        [f.variantId, days[0]],
      )
      expect(rows[0]).toMatchObject({ capacity: 3, qty_booked: 0 })
    })
  })

  it('снятие отключения возвращает доступность', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const from = new Date(Date.now() + 2 * DAY)
      const to = new Date(from.getTime() + DAY)
      const days = isoDays(from, 2)
      await stock(c, f, days)

      await blackoutVariant(c, {
        tenantId: f.tenantId, variantId: f.variantId,
        from: days[0]!, to: days[1]!, reason: 'ремонт',
      })
      expect((await checkAvailability(c, {
        tenantId: f.tenantId, variantId: f.variantId, from, to, timezone: TZ,
      })).available).toBe(false)

      await clearBlackout(c, { tenantId: f.tenantId, variantId: f.variantId, from: days[0]!, to: days[1]! })

      expect((await checkAvailability(c, {
        tenantId: f.tenantId, variantId: f.variantId, from, to, timezone: TZ,
      })).available, 'после снятия снова доступно').toBe(true)
    })
  })

  it('отключение одного варианта не задевает соседний', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const { rows: [v2] } = await c.query(
        `INSERT INTO inventory_variant (tenant_id, branch_id, category_id, code, name)
         SELECT tenant_id, branch_id, category_id, 'sb-162', '{"ru":"162"}'
         FROM inventory_variant WHERE id = $1 RETURNING id`,
        [f.variantId],
      )
      const from = new Date(Date.now() + 2 * DAY)
      const to = new Date(from.getTime() + DAY)
      const days = isoDays(from, 2)
      await stock(c, f, days)
      await stock(c, { ...f, variantId: v2.id }, days)

      await blackoutVariant(c, {
        tenantId: f.tenantId, variantId: f.variantId,
        from: days[0]!, to: days[1]!, reason: 'ремонт',
      })

      expect((await checkAvailability(c, {
        tenantId: f.tenantId, variantId: v2.id, from, to, timezone: TZ,
      })).available, 'соседний размер продаётся').toBe(true)
    })
  })
})
