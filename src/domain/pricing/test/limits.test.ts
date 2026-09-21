/**
 * Тесты лимитов бронирования.
 *
 * Из ТЗ (../rental-docs/docs/04-тз/10-бэкенд/12-наличие-и-жизненный-цикл.md): лимита позиций
 * в заказе нет намеренно, защиту дают механизмы, не зависящие от
 * размера заказа — доля пула и глубина вперёд.
 */
import { describe, expect, it } from 'vitest'
import { checkAdvanceDays } from '~/domain/pricing/limits'
import { backoffMinutes } from '~/domain/core/outbox'

const KRSK = 'Asia/Krasnoyarsk'

describe('checkAdvanceDays', () => {
  const now = new Date('2026-09-02T13:00:00Z')

  it('в пределах глубины — нарушения нет', () => {
    const from = new Date('2026-11-01T03:00:00Z') // ~60 дней

    expect(checkAdvanceDays({ from, now, timezone: KRSK, allowed: 90 })).toBeNull()
  })

  it('за пределами глубины — нарушение с числами', () => {
    const from = new Date('2027-06-01T03:00:00Z')
    const v = checkAdvanceDays({ from, now, timezone: KRSK, allowed: 90 })

    expect(v?.kind).toBe('advance_days')
    expect(v && 'allowed' in v && v.allowed).toBe(90)
    expect(v && 'requested' in v && v.requested).toBeGreaterThan(90)
  })

  it('ровно на границе разрешено', () => {
    // Ровно 90 локальных дней вперёд.
    const from = new Date(now.getTime() + 90 * 86_400_000)

    expect(checkAdvanceDays({ from, now, timezone: KRSK, allowed: 90 })).toBeNull()
  })

  it('⚠️ дни считаются по календарю филиала, а не в часах', () => {
    // 2 сентября 20:00 UTC — это уже 3 сентября в Красноярске,
    // то есть «завтра», хотя прошло всего 7 часов.
    const from = new Date('2026-09-02T20:00:00Z')
    const v = checkAdvanceDays({ from, now, timezone: KRSK, allowed: 0 })

    // При лимите 0 («только сегодня») бронь на завтра запрещена.
    expect(v?.kind).toBe('advance_days')
    expect(v && 'requested' in v && v.requested).toBe(1)
  })
})

describe('backoffMinutes', () => {
  it('задержка растёт, чтобы не устраивать шторм упавшему сервису', () => {
    expect(backoffMinutes(1)).toBe(2)
    expect(backoffMinutes(2)).toBe(4)
    expect(backoffMinutes(3)).toBe(8)
    expect(backoffMinutes(4)).toBe(16)
  })

  it('но не растёт бесконечно', () => {
    expect(backoffMinutes(10)).toBe(60)
    expect(backoffMinutes(100)).toBe(60)
  })
})
