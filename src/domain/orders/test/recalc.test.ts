/**
 * Тесты перерасчёта при досрочном и частичном возврате.
 *
 * ⚠️ Перерасчёт обязателен по ГК ст. 630, поэтому это не «удобство»,
 * а требование закона. Проверяется в том числе главная ловушка:
 * досрочный возврат не может выйти дороже полного срока.
 */
import { describe, expect, it } from 'vitest'
import { recalculate, recalculateSet, type SnapshotLine } from '~/domain/orders/recalc'

const KRSK = 'Asia/Krasnoyarsk'

/** Снимок заказа: сноуборд 900 ₽/день × 3 дня, ботинки 500 × 3. */
const snapshot: SnapshotLine[] = [
  { variantId: 'sb', variantName: 'Сноуборд 157', qty: 1, unitTotal: '2700.00', days: 3 },
  { variantId: 'bt', variantName: 'Ботинки 42', qty: 1, unitTotal: '1500.00', days: 3 },
]

// Аренда 10-12 марта по календарю Красноярска.
const from = new Date('2026-03-10T04:00:00Z') // 11:00 местного
const originalTo = new Date('2026-03-12T11:00:00Z') // 18:00 местного

describe('recalculate', () => {
  it('ничего не вернули раньше — сумма не меняется', () => {
    const r = recalculate({
      snapshot, originalTotal: '4200.00', from, originalTo,
      returns: [], dayMode: 'calendar', timezone: KRSK,
    })

    expect(r.total).toBe('4200.00')
    expect(r.refund).toBe('0.00')
  })

  it('досрочный возврат всего заказа: платим за фактический срок', () => {
    // Вернули оба предмета 11 марта — это 2 календарных дня.
    const returnedAt = new Date('2026-03-11T11:00:00Z')
    const r = recalculate({
      snapshot, originalTotal: '4200.00', from, originalTo,
      returns: [
        { variantId: 'sb', returnedAt, qty: 1 },
        { variantId: 'bt', returnedAt, qty: 1 },
      ],
      dayMode: 'calendar', timezone: KRSK,
    })

    // 900 × 2 + 500 × 2 = 2800
    expect(r.total).toBe('2800.00')
    expect(r.refund).toBe('1400.00')
    expect(r.lines.every((l) => l.actualDays === 2)).toBe(true)
  })

  it('частичный возврат: вернули борд, ботинки оставили', () => {
    const r = recalculate({
      snapshot, originalTotal: '4200.00', from, originalTo,
      returns: [{ variantId: 'sb', returnedAt: new Date('2026-03-11T11:00:00Z'), qty: 1 }],
      dayMode: 'calendar', timezone: KRSK,
    })

    // Борд 900 × 2 = 1800, ботинки остались на 3 дня = 1500.
    expect(r.total).toBe('3300.00')
    expect(r.refund).toBe('900.00')
    expect(r.lines.find((l) => l.variantId === 'sb')?.actualDays).toBe(2)
    expect(r.lines.find((l) => l.variantId === 'bt')?.actualDays).toBe(3)
  })

  it('⚠️ вернули через час — платим за один день, а не за ноль', () => {
    const r = recalculate({
      snapshot, originalTotal: '4200.00', from, originalTo,
      returns: [
        { variantId: 'sb', returnedAt: new Date('2026-03-10T05:00:00Z'), qty: 1 },
        { variantId: 'bt', returnedAt: new Date('2026-03-10T05:00:00Z'), qty: 1 },
      ],
      dayMode: 'calendar', timezone: KRSK,
    })

    // Иначе «взял и сразу вернул» стоило бы ноль.
    expect(r.total).toBe('1400.00')
    expect(r.lines.every((l) => l.actualDays === 1)).toBe(true)
  })

  it('⚠️ вернули ПОЗЖЕ срока — перерасчёт не увеличивает сумму', () => {
    // Просрочка считается отдельно (overdue и доплата), а не
    // перерасчётом в сторону увеличения.
    const r = recalculate({
      snapshot, originalTotal: '4200.00', from, originalTo,
      returns: [
        { variantId: 'sb', returnedAt: new Date('2026-03-20T11:00:00Z'), qty: 1 },
        { variantId: 'bt', returnedAt: new Date('2026-03-20T11:00:00Z'), qty: 1 },
      ],
      dayMode: 'calendar', timezone: KRSK,
    })

    expect(r.total).toBe('4200.00')
    expect(r.refund).toBe('0.00')
  })

  it('⚠️ итог никогда не превышает первоначальную сумму', () => {
    // Искусственный случай: снимок даёт больше, чем заплатили
    // (так бывает у комплекта — сумма частей больше цены набора).
    const r = recalculate({
      snapshot, originalTotal: '3000.00', from, originalTo,
      returns: [], dayMode: 'calendar', timezone: KRSK,
    })

    expect(r.total).toBe('3000.00')
    expect(r.cappedAtOriginal).toBe(true)
    expect(r.refund).toBe('0.00')
  })

  it('⚠️ модель суток влияет на перерасчёт: те же часы, разные счёты', () => {
    // Возврат 11 марта в 09:00 местного (02:00 UTC) — это ровно
    // 22 часа от выдачи в 11:00 10 марта.
    const returnedAt = new Date('2026-03-11T02:00:00Z')
    const args = {
      snapshot, originalTotal: '4200.00', from, originalTo,
      returns: [
        { variantId: 'sb', returnedAt, qty: 1 },
        { variantId: 'bt', returnedAt, qty: 1 },
      ],
      timezone: KRSK,
    }

    const calendar = recalculate({ ...args, dayMode: 'calendar' })
    const rolling = recalculate({ ...args, dayMode: 'rolling24' })

    // Календарные: затронуты 10 и 11 марта — 2 дня, 2800 ₽.
    expect(calendar.total).toBe('2800.00')
    // Скользящие: 22 часа не дотягивают до суток, но неполные сутки
    // тарифицируются как сутки — 1 день, 1400 ₽.
    expect(rolling.total).toBe('1400.00')
    // Разница 1400 ₽ на одном и том же возврате: поэтому day_mode
    // и обязан быть настройкой тенанта, а не константой.
    expect(Number(calendar.total) - Number(rolling.total)).toBe(1400)
  })
})

describe('recalculateSet', () => {
  // Пример прямо из ТЗ: комплект 800 ₽/день × 3 дня = 2400,
  // борд вернули через 2 дня, ботинки и шлем оставили на третий.
  const memberPrices = { sb: '500.00', bt: '300.00', hl: '200.00' }

  it('цена комплекта — только за дни полного состава', () => {
    const r = recalculateSet({
      setPricePerDay: '800.00',
      memberPrices,
      fullDays: 2,
      remaining: [{ variantId: 'bt', days: 1 }, { variantId: 'hl', days: 1 }],
      originalTotal: '2400.00',
    })

    // 800 × 2 = 1600, плюс ботинки 300 и шлем 200 за третий день.
    expect(r.total).toBe('2100.00')
    expect(r.refund).toBe('300.00')
  })

  it('⚠️ после распада — ОТДЕЛЬНЫЕ цены, а не доля комплекта', () => {
    // Скидка комплекта существует только пока берут всё вместе:
    // иначе шлем ушёл бы дешевле собственной цены.
    const r = recalculateSet({
      setPricePerDay: '800.00',
      memberPrices,
      fullDays: 1,
      remaining: [{ variantId: 'bt', days: 2 }, { variantId: 'hl', days: 2 }],
      originalTotal: '2400.00',
    })

    // 800 + (300 + 200) × 2 = 1800 — больше, чем доля комплекта дала бы.
    expect(r.total).toBe('1800.00')
  })

  it('⚠️ но итог не дороже первоначальной суммы', () => {
    // Сумма частей может превысить цену набора — тогда берётся
    // первоначальная сумма, иначе досрочный возврат дороже полного срока.
    const r = recalculateSet({
      setPricePerDay: '800.00',
      memberPrices: { bt: '900.00', hl: '900.00' },
      fullDays: 1,
      remaining: [{ variantId: 'bt', days: 2 }, { variantId: 'hl', days: 2 }],
      originalTotal: '2400.00',
    })

    expect(r.total).toBe('2400.00')
    expect(r.cappedAtOriginal).toBe(true)
    expect(r.refund).toBe('0.00')
  })
})
