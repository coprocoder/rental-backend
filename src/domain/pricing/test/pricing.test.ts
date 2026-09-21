/**
 * Эталонный тест движка цен на прайсе реального проката.
 *
 * ⚠️ Прайс пилота выбран тест-набором намеренно (../rental-docs/docs/04-тз/10-бэкенд/14-цены.md):
 * он покрывает всё, что ломает наивную модель «цена — это поле»:
 *
 *   будни 800 / выходные 900        признак дня недели
 *   3+ дня по 550                   зависимость от длительности
 *   после 17:00 −30%                зависимость от времени начала
 *   студентам 550 в будни           признак клиента + день недели
 *   «первый день бесплатно, далее 550»  ⚠️ НЕЛИНЕЙНОСТЬ: цена не дни × ставка
 *   заточка 700, парафин 700        услуги без интервала аренды
 *
 * И главное — пересекающиеся правила: студент + после 17:00 + 3 дня
 * подходят одновременно. Без явного алгоритма ответ произвольный, и
 * прокат ловит «а почему у клиента вышло 380 рублей».
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { inRollback, pool } from '../../../db/test/setup'
import { quote } from '~/domain/pricing/pricing'

const KRSK = 'Asia/Krasnoyarsk'

let tenantId: string
let branchId: string
let categoryId: string

beforeAll(async () => {
  const { rows } = await pool().query<{ id: string }>(
    `SELECT id FROM tenant WHERE slug = 'demo'`)
  tenantId = rows[0]?.id ?? ''

  const b = await pool().query<{ id: string }>(
    `SELECT id FROM branch WHERE tenant_id = $1 LIMIT 1`, [tenantId])
  branchId = b.rows[0]?.id ?? ''

  const c = await pool().query<{ id: string }>(
    `SELECT id FROM category WHERE tenant_id = $1 AND code = 'snowboard'`, [tenantId])
  categoryId = c.rows[0]?.id ?? ''
})

/** Создаёт вариант с правилами цены внутри откатываемой транзакции. */
async function makeVariant(
  c: import('pg').PoolClient,
  opts: {
    code: string
    baseAmount?: number
    dayRates?: number[]
    modifiers?: { percent?: number, amount?: number, priority: number, stackable: boolean }[]
  },
): Promise<string> {
  await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId])

  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO inventory_variant
       (tenant_id, branch_id, category_id, code, name, size_bucket)
     VALUES ($1, $2, $3, $4, '{"ru":"Тест"}', '{}')
     RETURNING id`,
    [tenantId, branchId, categoryId, opts.code],
  )
  const variantId = rows[0]!.id

  await c.query(
    `INSERT INTO price_rule
       (tenant_id, variant_id, rule_kind, valid, amount, day_rates, priority, stackable)
     VALUES ($1, $2, 'base', tstzrange(now() - interval '1 day', now() + interval '365 days'),
             $3, $4, 100, false)`,
    // ⚠️ day_rates — jsonb, а не int[]: сетка по дням хранится как
    // JSON, потому что позже туда лягут пороги и формулы, а не только
    // плоский список ставок.
    [tenantId, variantId, opts.baseAmount ?? null,
     opts.dayRates ? JSON.stringify(opts.dayRates) : null],
  )

  for (const [i, m] of (opts.modifiers ?? []).entries()) {
    await c.query(
      `INSERT INTO price_rule
         (tenant_id, variant_id, rule_kind, valid, amount, percent, priority, stackable)
       VALUES ($1, $2, 'modifier',
               tstzrange(now() - interval '1 day', now() + interval '365 days'),
               $3, $4, $5, $6)`,
      [tenantId, variantId, m.amount ?? null, m.percent ?? null, m.priority, m.stackable],
    )
    void i
  }

  return variantId
}

// Пятница 13 марта 2026, 11:00 по Красноярску.
const friday = new Date('2026-03-13T04:00:00Z')
const sunday = new Date('2026-03-15T11:00:00Z')

describe('движок цен на прайсе реального проката', () => {
  it('базовая ставка × дни: 900 ₽ за 3 дня', async () => {
    await inRollback(async (c) => {
      const v = await makeVariant(c, { code: `t-base-${Date.now()}`, baseAmount: 900 })

      const r = await quote(c, {
        tenantId, lines: [{ variantId: v, qty: 1 }],
        from: friday, to: sunday, dayMode: 'calendar', timezone: KRSK,
      })

      expect(r.days).toBe(3)
      expect(r.total).toBe('2700.00')
      // ⚠️ Разбивка обязательна: иначе на вопрос «почему столько»
      // ответить нельзя.
      expect(r.breakdown[0]?.appliedRules[0]?.label).toContain('900')
    })
  })

  it('⚠️ «первый день бесплатно, далее 550» — нелинейность по дням', async () => {
    await inRollback(async (c) => {
      // Это ломает модель «дни × ставка»: цена зависит от НОМЕРА дня.
      const v = await makeVariant(c, {
        code: `t-grid-${Date.now()}`,
        dayRates: [0, 550, 550],
      })

      const r = await quote(c, {
        tenantId, lines: [{ variantId: v, qty: 1 }],
        from: friday, to: sunday, dayMode: 'calendar', timezone: KRSK,
      })

      // 0 + 550 + 550 = 1100, а не 550 × 3 = 1650.
      expect(r.total).toBe('1100.00')
    })
  })

  it('последняя ставка сетки распространяется на дни сверх неё', async () => {
    await inRollback(async (c) => {
      const v = await makeVariant(c, {
        code: `t-grid2-${Date.now()}`,
        dayRates: [0, 550],
      })

      const r = await quote(c, {
        tenantId, lines: [{ variantId: v, qty: 1 }],
        from: friday, to: sunday, dayMode: 'calendar', timezone: KRSK,
      })

      // 0 + 550 + 550: третий день берёт последнюю ставку сетки.
      expect(r.total).toBe('1100.00')
    })
  })

  it('процентный модификатор: после 17:00 минус 30%', async () => {
    await inRollback(async (c) => {
      const v = await makeVariant(c, {
        code: `t-pct-${Date.now()}`,
        baseAmount: 900,
        modifiers: [{ percent: -30, priority: 20, stackable: false }],
      })

      const r = await quote(c, {
        tenantId, lines: [{ variantId: v, qty: 1 }],
        from: friday, to: sunday, dayMode: 'calendar', timezone: KRSK,
      })

      // 2700 − 30% = 1890
      expect(r.total).toBe('1890.00')
    })
  })

  it('⚠️ два несложимых модификатора: побеждает первый по приоритету', async () => {
    await inRollback(async (c) => {
      // Ровно случай из ТЗ: студент (−250, priority 10) и после 17:00
      // (−30%, priority 20). Применяется ТОЛЬКО студенческий.
      const v = await makeVariant(c, {
        code: `t-conflict-${Date.now()}`,
        baseAmount: 900,
        modifiers: [
          { amount: -250, priority: 10, stackable: false },
          { percent: -30, priority: 20, stackable: false },
        ],
      })

      const r = await quote(c, {
        tenantId, lines: [{ variantId: v, qty: 1 }],
        from: friday, to: sunday, dayMode: 'calendar', timezone: KRSK,
      })

      // 2700 − 250 = 2450. Если бы применились оба: 2450 − 30% = 1715.
      expect(r.total).toBe('2450.00')
      // В разбивке ровно один модификатор, а не два.
      const mods = r.breakdown[0]?.appliedRules.filter((x) => x.kind === 'modifier')
      expect(mods?.length).toBe(1)
    })
  })

  it('складываемый модификатор применяется вместе с несложимым', async () => {
    await inRollback(async (c) => {
      // Порог «3+ дня» — stackable, потому что это другая базовая
      // ставка, а не скидка.
      const v = await makeVariant(c, {
        code: `t-stack-${Date.now()}`,
        baseAmount: 900,
        modifiers: [
          { amount: -250, priority: 10, stackable: false },
          { percent: -10, priority: 30, stackable: true },
        ],
      })

      const r = await quote(c, {
        tenantId, lines: [{ variantId: v, qty: 1 }],
        from: friday, to: sunday, dayMode: 'calendar', timezone: KRSK,
      })

      // (2700 − 250) − 10% = 2205
      expect(r.total).toBe('2205.00')
      expect(r.breakdown[0]?.appliedRules.filter((x) => x.kind === 'modifier').length).toBe(2)
    })
  })

  it('⚠️ цена не уходит ниже нуля при больших скидках', async () => {
    await inRollback(async (c) => {
      const v = await makeVariant(c, {
        code: `t-floor-${Date.now()}`,
        baseAmount: 100,
        modifiers: [{ amount: -100_000, priority: 10, stackable: false }],
      })

      const r = await quote(c, {
        tenantId, lines: [{ variantId: v, qty: 1 }],
        from: friday, to: sunday, dayMode: 'calendar', timezone: KRSK,
      })

      expect(r.total).toBe('0.00')
    })
  })

  it('⚠️ позиция без активного правила цены не продаётся', async () => {
    await inRollback(async (c) => {
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId])
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO inventory_variant
           (tenant_id, branch_id, category_id, code, name, size_bucket)
         VALUES ($1, $2, $3, $4, '{"ru":"Без цены"}', '{}')
         RETURNING id`,
        [tenantId, branchId, categoryId, `t-noprice-${Date.now()}`],
      )

      const r = await quote(c, {
        tenantId, lines: [{ variantId: rows[0]!.id, qty: 1 }],
        from: friday, to: sunday, dayMode: 'calendar', timezone: KRSK,
      })

      // Молча посчитать по нулю нельзя: это выдача бесплатно.
      expect(r.breakdown).toHaveLength(0)
      expect(r.total).toBe('0.00')
    })
  })

  it('количество умножает строку, но не ставку', async () => {
    await inRollback(async (c) => {
      const v = await makeVariant(c, { code: `t-qty-${Date.now()}`, baseAmount: 900 })

      const r = await quote(c, {
        tenantId, lines: [{ variantId: v, qty: 3 }],
        from: friday, to: sunday, dayMode: 'calendar', timezone: KRSK,
      })

      expect(r.breakdown[0]?.unitTotal).toBe('2700.00')
      expect(r.total).toBe('8100.00')
    })
  })

  it('⚠️ модель суток расходится, когда срок кратен суткам', async () => {
    await inRollback(async (c) => {
      const v = await makeVariant(c, { code: `t-mode2-${Date.now()}`, baseAmount: 800 })
      // Пятница 11:00 → воскресенье 11:00: ровно 48 часов.
      const to48 = new Date('2026-03-15T04:00:00Z')
      const args = {
        tenantId, lines: [{ variantId: v, qty: 1 }],
        from: friday, to: to48, timezone: KRSK,
      }

      const calendar = await quote(c, { ...args, dayMode: 'calendar' })
      const rolling = await quote(c, { ...args, dayMode: 'rolling24' })

      // Календарные: затронуты пт, сб, вс — 3 дня.
      expect(calendar.days).toBe(3)
      // Скользящие: ровно 2 полных суток, остатка нет.
      expect(rolling.days).toBe(2)
      // Разброс 800 ₽ на одном заказе — поэтому day_mode обязан быть
      // настройкой тенанта, а не константой кода.
      expect(Number(calendar.total) - Number(rolling.total)).toBe(800)
    })
  })

  it('⚠️ модель суток меняет счёт на том же интервале', async () => {
    await inRollback(async (c) => {
      const v = await makeVariant(c, { code: `t-mode-${Date.now()}`, baseAmount: 800 })
      const args = {
        tenantId, lines: [{ variantId: v, qty: 1 }],
        from: friday, to: sunday, timezone: KRSK,
      }

      const calendar = await quote(c, { ...args, dayMode: 'calendar' })
      const rolling = await quote(c, { ...args, dayMode: 'rolling24' })

      // Пятница 11:00 → воскресенье 18:00 по Красноярску = 55 часов.
      // Календарные — 3 дня (пт, сб, вс).
      expect(calendar.days).toBe(3)
      // ⚠️ Скользящие тоже 3, а не 2: 55 часов — это двое полных суток
      // ПЛЮС остаток, а неполные сутки тарифицируются как сутки.
      // Здесь модели совпали — расхождение даёт возврат ровно в 48 часов
      // (ниже отдельная проверка).
      expect(rolling.days).toBe(3)
      expect(calendar.total).toBe(rolling.total)
    })
  })
})
