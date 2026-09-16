/**
 * Движок правил цены.
 *
 * ⚠️ Цена считается ТОЛЬКО на сервере: на клиенте её можно подделать,
 * а логика подбора — то, что защищает продукт от копирования
 * (железное правило №1).
 *
 * Порядок вычисления (../rental-docs/docs/04-тз/10-бэкенд/14-цены.md):
 *   1. базовая ставка — ровно одна активная на вариант и дату
 *   2. сетка по дням — нелинейность «первый день бесплатно»
 *   3. модификаторы по priority; несложимые: побеждает первый
 *   4. ограничение снизу
 *
 * ⚠️ В снимок заказа пишется РАЗБИВКА, а не только сумма: иначе на
 * вопрос «почему вышло 380 рублей» ответить нельзя.
 */
import type { PoolClient } from 'pg'
import { countRentalDays, type DayMode } from '~/common/contract/day-count'

export interface PriceLineInput {
  variantId: string
  qty: number
  /**
   * Услуга без интервала аренды: заточка, парафин.
   *
   * ⚠️ Отдельный вид строки, а не аренда с нулевым сроком: если уложить
   * заточку в ту же модель, что сноуборд, сломается и то и другое —
   * у услуги нет ни дней, ни наличия, ни буфера (../rental-docs/docs/04-тз/10-бэкенд/14-цены.md).
   * Цена = ставка × количество, дни не участвуют.
   */
  kind?: 'rental' | 'service'
}

export interface PriceBreakdownEntry {
  variantId: string
  variantName: string
  qty: number
  days: number
  /** Цена за единицу за весь срок. */
  unitTotal: string
  lineTotal: string
  appliedRules: { kind: string, label: string, effect: string }[]
}

export interface QuoteResult {
  total: string
  days: number
  breakdown: PriceBreakdownEntry[]
}

/** Копейки как целое, чтобы не терять точность на промежуточных шагах. */
function toKopecks(v: string | number): number {
  return Math.round(Number(v) * 100)
}

function fromKopecks(k: number): string {
  return (k / 100).toFixed(2)
}

/**
 * Считает цену заказа.
 *
 * ⚠️ Дни считает функция от day_mode, а не разница дат в часах:
 * три модели дают разные счета на одном заказе.
 */
export async function quote(
  c: PoolClient,
  opts: {
    tenantId: string
    lines: PriceLineInput[]
    from: Date
    to: Date
    dayMode: DayMode
    timezone: string
  },
): Promise<QuoteResult> {
  const days = countRentalDays(opts.from, opts.to, opts.dayMode, opts.timezone)
  // ⚠️ Нулевой срок обнуляет только АРЕНДУ: заказ из одних услуг
  // (заточка своего борда) законен и без интервала.
  const onlyServices = opts.lines.every((l) => l.kind === 'service')
  if ((days === 0 && !onlyServices) || opts.lines.length === 0) {
    return { total: '0.00', days, breakdown: [] }
  }

  const variantIds = opts.lines.map((l) => l.variantId)

  const { rows } = await c.query<{
    id: string
    name: { ru?: string }
    amount: string | null
    day_rates: number[] | null
    rule_kind: string | null
    priority: number | null
    stackable: boolean | null
    percent: number | null
  }>(
    `SELECT v.id, v.name,
            pr.amount, pr.day_rates, pr.rule_kind, pr.priority, pr.stackable, pr.percent
     FROM inventory_variant v
     LEFT JOIN price_rule pr
       ON pr.variant_id = v.id
      AND pr.is_active
      AND pr.archived_at IS NULL
      AND pr.valid @> now()
     WHERE v.id = ANY($1::uuid[]) AND v.tenant_id = $2`,
    [variantIds, opts.tenantId],
  )

  const byVariant = new Map<string, typeof rows>()
  for (const r of rows) {
    const list = byVariant.get(r.id) ?? []
    list.push(r)
    byVariant.set(r.id, list)
  }

  const breakdown: PriceBreakdownEntry[] = []
  let totalKop = 0

  for (const line of opts.lines) {
    const variantRules = byVariant.get(line.variantId)
    if (!variantRules?.length) continue

    const first = variantRules[0]!
    const variantName = first.name?.ru ?? 'Позиция'

    // 1. Базовая ставка.
    //
    // ⚠️ Правило годно, если задан ХОТЬ ОДИН способ посчитать цену:
    // скалярная ставка ИЛИ сетка по дням. Проверять только amount
    // нельзя — правило «первый день бесплатно, дальше 550» задаётся
    // одной сеткой (day_rates), и при проверке по amount такая позиция
    // молча выпадала из расчёта с итогом 0 ₽. То есть нелинейный прайс,
    // ради которого сетка и существует, не работал вообще.
    const base = variantRules.find(
      (r) => r.rule_kind === 'base' && (r.amount !== null || r.day_rates?.length),
    )
    if (!base) {
      // Нет активного правила цены — позиция не продаётся.
      // Молча считать по нулю нельзя: это выдача бесплатно.
      continue
    }

    const applied: PriceBreakdownEntry['appliedRules'] = []

    // 2. Сетка по дням: если задана, платим по номеру дня.
    //    Иначе — базовая ставка × дни.
    let unitKop: number
    if (base.day_rates?.length) {
      unitKop = 0
      for (let d = 0; d < days; d++) {
        // Последняя ставка распространяется на все дни сверх сетки.
        const rate = base.day_rates[Math.min(d, base.day_rates.length - 1)] ?? 0
        unitKop += toKopecks(rate)
      }
      applied.push({
        kind: 'base',
        label: 'Сетка по дням',
        effect: base.day_rates.slice(0, days).join(' + ') + ' ₽',
      })
    } else {
      // Сетки нет, значит есть amount — это гарантировано выбором base.
      // Услуга — плоская цена: заточка стоит 700 ₽ за раз, а не за день.
      unitKop = line.kind === 'service'
        ? toKopecks(base.amount!)
        : toKopecks(base.amount!) * days
      applied.push({
        kind: 'base',
        label: line.kind === 'service'
          ? `${Number(base.amount!).toFixed(0)} ₽ за услугу`
          : `${Number(base.amount!).toFixed(0)} ₽ × ${days} дн.`,
        effect: fromKopecks(unitKop) + ' ₽',
      })
    }

    // 3. Модификаторы: по priority, несложимые — только первый.
    const modifiers = variantRules
      .filter((r) => r.rule_kind === 'modifier')
      .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))

    let nonStackableApplied = false
    for (const m of modifiers) {
      if (!m.stackable && nonStackableApplied) continue

      if (m.percent) {
        const delta = Math.round((unitKop * m.percent) / 100)
        unitKop += delta
        applied.push({
          kind: 'modifier',
          label: `${m.percent > 0 ? '+' : ''}${m.percent}%`,
          effect: fromKopecks(delta) + ' ₽',
        })
      } else if (m.amount) {
        const delta = toKopecks(m.amount)
        unitKop += delta
        applied.push({
          kind: 'modifier',
          label: `${delta > 0 ? '+' : ''}${fromKopecks(delta)} ₽`,
          effect: fromKopecks(delta) + ' ₽',
        })
      }

      if (!m.stackable) nonStackableApplied = true
    }

    // 4. Ниже нуля цена не опускается.
    unitKop = Math.max(0, unitKop)
    const lineKop = unitKop * line.qty
    totalKop += lineKop

    breakdown.push({
      variantId: line.variantId,
      variantName,
      qty: line.qty,
      days,
      unitTotal: fromKopecks(unitKop),
      lineTotal: fromKopecks(lineKop),
      appliedRules: applied,
    })
  }

  return { total: fromKopecks(totalKop), days, breakdown }
}
