/**
 * Тесты сезонности.
 *
 * Главный тест — согласие TS-реализации с SQL-функцией на всех
 * комбинациях: две реализации одного правила обязаны совпадать, иначе
 * каталог покажет категорию, которую отчёт считает неактивной.
 */
import { describe, expect, it } from 'vitest'
import { describeSeason, localMonth, monthInSeason, seasonAllows } from '~/common/contract/season'
import { pool } from './setup'

const KRSK = 'Asia/Krasnoyarsk'

describe('monthInSeason', () => {
  it('сезон внутри года: лето 5→9', () => {
    const summer = { fromMonth: 5, toMonth: 9 }
    expect(monthInSeason(7, summer)).toBe(true)
    expect(monthInSeason(5, summer)).toBe(true)
    expect(monthInSeason(9, summer)).toBe(true)
    expect(monthInSeason(4, summer)).toBe(false)
    expect(monthInSeason(10, summer)).toBe(false)
  })

  it('⚠️ сезон через Новый год: зима 11→4', () => {
    const winter = { fromMonth: 11, toMonth: 4 }
    expect(monthInSeason(12, winter)).toBe(true)
    expect(monthInSeason(1, winter)).toBe(true)
    expect(monthInSeason(4, winter)).toBe(true)
    expect(monthInSeason(11, winter)).toBe(true)
    expect(monthInSeason(7, winter)).toBe(false)
    expect(monthInSeason(10, winter)).toBe(false)
  })

  it('null — круглый год, в том числе половина границы', () => {
    for (const m of [1, 6, 12]) {
      expect(monthInSeason(m, { fromMonth: null, toMonth: null })).toBe(true)
      // Недозаполненная форма не закрывает категорию.
      expect(monthInSeason(m, { fromMonth: 11, toMonth: null })).toBe(true)
    }
  })

  it('⚠️ TS и SQL согласны на всех 12×12×12 комбинациях', async () => {
    const { rows } = await pool().query<{ m: number, f: number, t: number, sql: boolean }>(
      `SELECT m, f, t, season_month_active(m, f, t) AS sql
       FROM generate_series(1, 12) m,
            generate_series(1, 12) f,
            generate_series(1, 12) t`,
    )
    expect(rows).toHaveLength(12 * 12 * 12)
    for (const r of rows) {
      expect(monthInSeason(r.m, { fromMonth: r.f, toMonth: r.t })).toBe(r.sql)
    }
    // И NULL-случаи.
    const { rows: nulls } = await pool().query<{ sql: boolean }>(
      `SELECT season_month_active(7, NULL, 4) AS sql
       UNION ALL SELECT season_month_active(7, NULL, NULL)`,
    )
    expect(nulls.every((r) => r.sql)).toBe(true)
  })
})

describe('seasonAllows', () => {
  const winter = { fromMonth: 11, toMonth: 4 }

  it('проверяется месяц НАЧАЛА аренды в поясе филиала', () => {
    // 30 апреля 23:00 по Красноярску — апрель, сезон. Хвост в мае не мешает.
    expect(seasonAllows(new Date('2026-04-30T16:00:00Z'), winter, KRSK)).toBe(true)
    // 25 октября — сноуборд ещё не в сезоне.
    expect(seasonAllows(new Date('2026-10-25T04:00:00Z'), winter, KRSK)).toBe(false)
  })

  it('⚠️ месяц берётся по календарю филиала, а не по UTC', () => {
    // 30 апреля 20:00 UTC = 1 мая 03:00 в Красноярске: уже май, не сезон.
    const d = new Date('2026-04-30T20:00:00Z')
    expect(localMonth(d, KRSK)).toBe(5)
    expect(localMonth(d, 'UTC')).toBe(4)
    expect(seasonAllows(d, winter, KRSK)).toBe(false)
    expect(seasonAllows(d, winter, 'UTC')).toBe(true)
  })

  it('клиент в апреле бронирует сапборд на июль — законно', () => {
    const summer = { fromMonth: 5, toMonth: 9 }
    // Дата визита не важна, проверяется дата аренды.
    expect(seasonAllows(new Date('2026-07-10T04:00:00Z'), summer, KRSK)).toBe(true)
  })
})

describe('describeSeason', () => {
  it('человеку понятно', () => {
    expect(describeSeason({ fromMonth: 11, toMonth: 4 })).toBe('ноя–апр')
    expect(describeSeason({ fromMonth: null, toMonth: null })).toBe('круглый год')
    expect(describeSeason({ fromMonth: 5, toMonth: 9 }, 'en')).toBe('May–Sep')
  })
})
