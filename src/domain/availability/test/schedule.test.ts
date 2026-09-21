/**
 * Тесты расписания филиала.
 *
 * Проверяется то, о чём ТЗ предупреждает как о частой ошибке
 * (../rental-docs/docs/04-тз/10-бэкенд/18-время-и-расписание.md): проверили выдачу, а
 * возврат попал на 23:00 закрытого дня.
 *
 * Плюс временная семантика: локальный день филиала, а не UTC.
 */
import { describe, expect, it } from 'vitest'
import { applyBuffer, localParts, ruleForDate, type ScheduleRow } from '~/domain/availability/schedule'

const KRSK = 'Asia/Krasnoyarsk' // UTC+7

describe('localParts', () => {
  it('даёт локальные дату, время и день недели филиала', () => {
    // 2 сентября 2026, 13:00 UTC = 20:00 в Красноярске, среда.
    const p = localParts(new Date('2026-09-02T13:00:00Z'), KRSK)

    expect(p.date).toBe('2026-09-02')
    expect(p.time).toBe('20:00')
    expect(p.weekday).toBe(3)
  })

  it('⚠️ локальный день может отличаться от UTC-дня', () => {
    // 20:00 UTC 2 сентября — это уже 03:00 3 сентября в Красноярске.
    const p = localParts(new Date('2026-09-02T20:00:00Z'), KRSK)

    expect(p.date).toBe('2026-09-03')
    expect(p.time).toBe('03:00')
    // И другой день недели: четверг, а не среда.
    expect(p.weekday).toBe(4)
  })

  it('полночь показывается как 00:00, а не 24:00', () => {
    // 17:00 UTC = 00:00 следующего дня в Красноярске.
    const p = localParts(new Date('2026-09-02T17:00:00Z'), KRSK)

    expect(p.time).toBe('00:00')
    expect(p.date).toBe('2026-09-03')
  })
})

describe('ruleForDate', () => {
  const rows: ScheduleRow[] = [
    { weekday: 5, exception_date: null, opens_at: '10:00', closes_at: '22:00', is_closed: false },
    { weekday: 6, exception_date: null, opens_at: '09:00', closes_at: '22:00', is_closed: false },
    // Праздник: 1 января закрыто.
    { weekday: null, exception_date: '2027-01-01', opens_at: null, closes_at: null, is_closed: true },
    // Сокращённый день.
    { weekday: null, exception_date: '2026-12-31', opens_at: '10:00', closes_at: '16:00', is_closed: false },
  ]

  it('берёт правило дня недели, если исключения нет', () => {
    const r = ruleForDate(rows, '2026-09-04', 5)

    expect(r?.opens_at).toBe('10:00')
    expect(r?.closes_at).toBe('22:00')
  })

  it('⚠️ исключение перекрывает день недели', () => {
    // 1 января 2027 — пятница, но это праздник.
    const r = ruleForDate(rows, '2027-01-01', 5)

    expect(r?.is_closed).toBe(true)
    // Не подхватило правило пятницы.
    expect(r?.opens_at).toBeNull()
  })

  it('сокращённый день переопределяет часы, не закрывая филиал', () => {
    const r = ruleForDate(rows, '2026-12-31', 4)

    expect(r?.is_closed).toBe(false)
    expect(r?.closes_at).toBe('16:00')
  })

  it('нет правила на этот день — ограничений нет', () => {
    // Вторник в списке отсутствует.
    expect(ruleForDate(rows, '2026-09-08', 2)).toBeNull()
  })
})

describe('applyBuffer', () => {
  it('расширяет интервал, а не меняет оператор пересечения', () => {
    const to = new Date('2026-09-05T12:00:00Z')

    // Ботинкам нужна просушка — час буфера.
    expect(applyBuffer(to, 60).toISOString()).toBe('2026-09-05T13:00:00.000Z')
  })

  it('по умолчанию буфера нет: прокат работает без настройки', () => {
    const to = new Date('2026-09-05T12:00:00Z')

    expect(applyBuffer(to, 0)).toBe(to)
  })
})

/**
 * Буфер подготовки между арендами (3.15, 20.9).
 *
 * ⚠️ Разбор смежных отраслей: в ресторанах «пересборка стола» ~10 минут
 * закладывается в оборот ВСЕГДА, а не по желанию. У проката то же самое
 * физически: ботинки после катания мокрые изнутри, и выдать их
 * следующему сразу нельзя. Поэтому у ботинок и шлемов буфер ненулевой
 * в сиде, а не только в теории.
 */
describe('applyBuffer', () => {
  it('расширяет интервал, а не меняет оператор', () => {
    // Железное правило 4: интервал остаётся полуоткрытым [from, to),
    // буфер лишь отодвигает верхнюю границу.
    const to = new Date('2026-01-10T15:00:00Z')
    expect(applyBuffer(to, 90).toISOString()).toBe('2026-01-10T16:30:00.000Z')
  })

  it('нулевой буфер не трогает границу вовсе', () => {
    // Прокат без настройки работает в день подключения: 0 — это
    // «как было», а не «плюс ноль миллисекунд другого объекта».
    const to = new Date('2026-01-10T15:00:00Z')
    expect(applyBuffer(to, 0)).toBe(to)
  })

  it('буфер не съедает выдачу встык при полуоткрытом интервале', () => {
    // Без буфера возврат в 15:00 и выдача в 15:00 не конфликтуют —
    // это и есть смысл [from, to). С буфером следующая выдача
    // возможна только с 16:30, и это ФИЗИЧЕСКОЕ ограничение.
    const handBack = new Date('2026-01-10T15:00:00Z')
    const freeAgain = applyBuffer(handBack, 90)
    expect(freeAgain.getTime()).toBeGreaterThan(handBack.getTime())
    expect(new Date('2026-01-10T16:00:00Z') < freeAgain).toBe(true)
  })
})
