/**
 * Правила лимитов — без базы.
 *
 * ⚠️ Смысл разделения: в Nuxt-версии `checkPoolShare` читала ёмкость
 * сама, и проверить правило «30%, но не меньше единицы» можно было
 * только подняв Postgres и заведя вариант. Здесь это таблица случаев.
 */
import { describe, expect, it } from 'vitest'
import { allowedShare, checkPoolShare, DEFAULT_LIMITS } from '../limits'

describe('allowedShare', () => {
  /**
   * ⚠️ Главный случай: при ёмкости 3 и доле 30% арифметика даёт 0.9.
   * Округление вниз означало бы, что мелкий пул недоступен НИКОМУ —
   * это не защита инвентаря, а отказ в обслуживании.
   */
  it('мелкий пул остаётся доступным: минимум одна единица', () => {
    expect(allowedShare(3, 30)).toBe(1)
    expect(allowedShare(1, 30)).toBe(1)
  })

  it('на крупном пуле работает собственно доля', () => {
    expect(allowedShare(100, 30)).toBe(30)
    expect(allowedShare(10, 50)).toBe(5)
  })

  it('округление вверх, а не к ближайшему', () => {
    // 7 × 30% = 2.1 → три единицы, а не две.
    expect(allowedShare(7, 30)).toBe(3)
  })
})

describe('checkPoolShare', () => {
  const base = { variantId: 'v1', sharePercent: DEFAULT_LIMITS.poolSharePercent }

  it('в пределах доли — нарушения нет', () => {
    expect(checkPoolShare({ ...base, qty: 3, capacity: 10 })).toBeNull()
  })

  it('сверх доли — нарушение с числами для сообщения клиенту', () => {
    const v = checkPoolShare({ ...base, qty: 5, capacity: 10 })

    expect(v).toEqual({
      kind: 'pool_share', variantId: 'v1', requested: 5, allowed: 3, capacity: 10,
    })
  })

  /**
   * ⚠️ Ёмкость 0 — это НЕ «ничего нельзя». Так выглядит вариант вне
   * поштучного учёта (`labeled`), где наличие считается по единицам,
   * а не по счётчику. Вернуть здесь нарушение значило бы запретить
   * бронирование именно там, где доля пула неприменима.
   */
  it('вариант без поштучного учёта долей не ограничивается', () => {
    expect(checkPoolShare({ ...base, qty: 99, capacity: 0 })).toBeNull()
  })

  /**
   * ⚠️ Граница считается ОТ ЁМКОСТИ, а не от остатка. Иначе лимит
   * слабеет по мере заполнения — ровно тогда, когда защита нужнее.
   */
  it('ровно на границе — ещё можно', () => {
    expect(checkPoolShare({ ...base, qty: 3, capacity: 10 })).toBeNull()
    expect(checkPoolShare({ ...base, qty: 4, capacity: 10 })).not.toBeNull()
  })
})
