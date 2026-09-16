/**
 * Перерасчёт при досрочном и частичном возврате.
 *
 * ⚠️ Обязателен по ГК ст. 630: клиент вправе вернуть вещь раньше и
 * заплатить за фактический срок. Невозвратные брони в РФ незаконны,
 * поэтому это не опция, а требование (../rental-docs/docs/04-тз/00-общее/04-правовое.md).
 *
 * ⚠️ Считается по СНИМКУ правил заказа, а не по текущему прайсу: иначе
 * смена цен через месяц изменит сумму возврата по старому заказу.
 *
 * Для комплекта правило неочевидно (../rental-docs/docs/04-тз/10-бэкенд/14-цены.md):
 * цена комплекта применяется только к дням, когда комплект был ПОЛОН.
 * Как только состав распался — оставшиеся позиции считаются по
 * отдельным ценам. Комплект дешевле суммы частей именно потому, что
 * берут всё вместе; сохранять скидку на неполный набор означало бы
 * отдавать шлем дешевле его собственной цены.
 *
 * ⚠️ И главная защита: итог НЕ МОЖЕТ превысить первоначальную сумму.
 * Иначе досрочный возврат оказался бы дороже полного срока — абсурд
 * и нарушение закона.
 */
import { countRentalDays, type DayMode } from '~/common/contract/day-count'

/** Копейки как целое: промежуточные шаги не теряют точность. */
function toKopecks(v: string | number): number {
  return Math.round(Number(v) * 100)
}

function fromKopecks(k: number): string {
  return (k / 100).toFixed(2)
}

export interface SnapshotLine {
  variantId: string
  variantName: string
  qty: number
  /** Цена за единицу за ВЕСЬ первоначальный срок, из снимка. */
  unitTotal: string
  /** Сколько дней было в первоначальном расчёте. */
  days: number
}

export interface ReturnedLine {
  variantId: string
  /** Когда фактически вернули эту позицию. */
  returnedAt: Date
  /** Сколько единиц вернули. Меньше qty — частичный возврат позиции. */
  qty: number
}

export interface RecalcInput {
  /** Снимок цены из заказа: price_breakdown. */
  snapshot: SnapshotLine[]
  originalTotal: string
  from: Date
  /** Первоначальный конец аренды. */
  originalTo: Date
  returns: ReturnedLine[]
  dayMode: DayMode
  timezone: string
}

export interface RecalcLine {
  variantId: string
  variantName: string
  qty: number
  /** Дней по факту. */
  actualDays: number
  originalDays: number
  /** Цена за единицу за день по снимку. */
  unitPerDay: string
  lineTotal: string
}

export interface RecalcResult {
  /** Итог по фактическому использованию. */
  total: string
  originalTotal: string
  /** Сколько вернуть клиенту. Ноль, если возвращать нечего. */
  refund: string
  lines: RecalcLine[]
  /** Сработало ли ограничение «не дороже первоначальной суммы». */
  cappedAtOriginal: boolean
}

/**
 * Пересчитывает заказ по фактическому сроку.
 *
 * ⚠️ Дни считаются той же функцией countRentalDays, что и при
 * бронировании: три модели day_mode дают разные счета, и перерасчёт
 * обязан использовать ту же, что и первоначальный расчёт.
 */
export function recalculate(input: RecalcInput): RecalcResult {
  const returnsByVariant = new Map<string, ReturnedLine>()
  for (const r of input.returns) returnsByVariant.set(r.variantId, r)

  const lines: RecalcLine[] = []
  let totalKop = 0

  for (const line of input.snapshot) {
    const returned = returnsByVariant.get(line.variantId)

    // Позицию не вернули — считаем по первоначальному сроку.
    const actualEnd = returned?.returnedAt ?? input.originalTo

    let actualDays = countRentalDays(
      input.from,
      actualEnd,
      input.dayMode,
      input.timezone,
    )

    // ⚠️ Фактический срок не может превысить первоначальный: если
    // вернули позже, это просрочка, и она считается отдельно
    // (доплата за overdue), а не перерасчётом в сторону увеличения.
    actualDays = Math.min(actualDays, line.days)

    // ⚠️ Минимум один день: даже вернув через час, клиент арендовал.
    // Иначе «взял и сразу вернул» стоило бы ноль.
    actualDays = Math.max(1, actualDays)

    // Цена за день из снимка: делим первоначальную сумму на дни.
    // ⚠️ Именно из снимка, а не из текущего прайса.
    const unitTotalKop = toKopecks(line.unitTotal)
    const perDayKop = line.days > 0 ? Math.round(unitTotalKop / line.days) : unitTotalKop

    const qty = returned?.qty ?? line.qty
    const lineKop = perDayKop * actualDays * qty
    totalKop += lineKop

    lines.push({
      variantId: line.variantId,
      variantName: line.variantName,
      qty,
      actualDays,
      originalDays: line.days,
      unitPerDay: fromKopecks(perDayKop),
      lineTotal: fromKopecks(lineKop),
    })
  }

  const originalKop = toKopecks(input.originalTotal)

  // ⚠️ Главная защита: досрочный возврат не может выйти дороже полного
  // срока. Для комплекта это возможно — сумма отдельных цен больше
  // цены набора, — и тогда берётся первоначальная сумма.
  const cappedAtOriginal = totalKop > originalKop
  if (cappedAtOriginal) totalKop = originalKop

  return {
    total: fromKopecks(totalKop),
    originalTotal: input.originalTotal,
    refund: fromKopecks(Math.max(0, originalKop - totalKop)),
    lines,
    cappedAtOriginal,
  }
}

/**
 * Перерасчёт комплекта по дням, когда он был полон.
 *
 * Правило из ТЗ: цена комплекта применяется только к дням полного
 * состава; после распада — отдельные цены позиций.
 *
 * @param setPricePerDay цена комплекта за день из снимка
 * @param memberPrices   цены отдельных позиций за день из снимка
 * @param fullDays       дней, когда комплект был полон
 * @param remaining      что осталось после распада и на сколько дней
 */
export function recalculateSet(opts: {
  setPricePerDay: string
  memberPrices: Record<string, string>
  fullDays: number
  remaining: { variantId: string, days: number }[]
  originalTotal: string
}): { total: string, refund: string, cappedAtOriginal: boolean } {
  let kop = toKopecks(opts.setPricePerDay) * opts.fullDays

  for (const r of opts.remaining) {
    // ⚠️ По ОТДЕЛЬНОЙ цене, а не по доле комплекта: скидка комплекта
    // существует только пока берут всё вместе.
    const price = opts.memberPrices[r.variantId]
    if (price) kop += toKopecks(price) * r.days
  }

  const originalKop = toKopecks(opts.originalTotal)
  const cappedAtOriginal = kop > originalKop
  if (cappedAtOriginal) kop = originalKop

  return {
    total: fromKopecks(kop),
    refund: fromKopecks(Math.max(0, originalKop - kop)),
    cappedAtOriginal,
  }
}
