/**
 * Тесты дедлайна подтверждения.
 *
 * Правила из ТЗ (../rental-docs/docs/04-тз/10-бэкенд/12-наличие-и-жизненный-цикл.md):
 * бронь на будущие даты снимается автоматически, если не подтверждена
 * за сутки до начала; бронь на сегодня не снимается никогда — её
 * снимает только оператор.
 *
 * Проверяется и то, что однажды сломалось: дедлайн не должен попадать
 * в прошлое и не должен истекать мгновенно, иначе автоснятие убирает
 * заказ сразу после того, как клиент увидел подтверждение.
 */
import { describe, expect, it } from 'vitest'
import {
  CONFIRM_LEAD_MS,
  MIN_CONFIRM_WINDOW_MS,
  confirmDeadline,
} from '~/domain/orders/confirm-deadline'

// Красноярск, UTC+7: 2 сентября 20:00 по местному времени.
const KRSK = 'Asia/Krasnoyarsk'
const now = new Date('2026-09-02T13:00:00Z')

describe('confirmDeadline', () => {
  it('бронь заранее: дедлайн ровно за сутки до начала', () => {
    const from = new Date('2026-09-07T03:00:00Z')
    const d = confirmDeadline(from, KRSK, now)

    expect(d?.toISOString()).toBe('2026-09-06T03:00:00.000Z')
    expect(from.getTime() - d!.getTime()).toBe(CONFIRM_LEAD_MS)
  })

  it('бронь на сегодня: автоснятия нет — снимает только оператор', () => {
    // 2 сентября 22:00 в Красноярске — тот же местный день, что и now.
    const from = new Date('2026-09-02T15:00:00Z')

    expect(confirmDeadline(from, KRSK, now)).toBeNull()
  })

  it('⚠️ «на сегодня» считается по календарю филиала, а не по UTC', () => {
    // 3 сентября 00:30 UTC — это 3 сентября 07:30 в Красноярске,
    // то есть УЖЕ завтра по местному времени, хотя от now меньше суток.
    const from = new Date('2026-09-03T00:30:00Z')

    // Значит автоснятие применяется: дедлайн есть.
    expect(confirmDeadline(from, KRSK, now)).not.toBeNull()

    // А для филиала в Москве (UTC+3) 2 сентября 23:30 — это ещё сегодня.
    expect(confirmDeadline(new Date('2026-09-02T20:30:00Z'), 'Europe/Moscow', now))
      .toBeNull()
  })

  it('оформлено позже чем за сутки, но не на сегодня: окно на подтверждение', () => {
    // Завтра 10:00 по Красноярску: суток до начала нет, но это не сегодня.
    const from = new Date('2026-09-03T03:00:00Z')
    const d = confirmDeadline(from, KRSK, now)

    expect(d).not.toBeNull()
    // Дедлайн не в прошлом и не мгновенный.
    expect(d!.getTime()).toBe(now.getTime() + MIN_CONFIRM_WINDOW_MS)
  })

  it('окно не выходит за начало аренды', () => {
    // Оформление 3 сентября 23:30 по Красноярску (16:30 UTC), начало —
    // 4 сентября 00:30 по Красноярску (17:30 UTC): разные местные дни,
    // значит автоснятие применяется, но до начала всего час — окно
    // в два часа должно обрезаться началом аренды.
    const near = new Date('2026-09-03T16:30:00Z')
    const from = new Date('2026-09-03T17:30:00Z')
    const d = confirmDeadline(from, KRSK, near)

    expect(d).not.toBeNull()
    expect(d!.getTime()).toBe(from.getTime())
  })

  it('дедлайн никогда не оказывается в прошлом', () => {
    // Свойство, которое защищает от автоснятия сразу после оформления.
    for (const hours of [1, 6, 23, 24, 25, 48, 24 * 30]) {
      const from = new Date(now.getTime() + hours * 3600 * 1000)
      const d = confirmDeadline(from, KRSK, now)
      if (d) expect(d.getTime()).toBeGreaterThanOrEqual(now.getTime())
    }
  })
})
