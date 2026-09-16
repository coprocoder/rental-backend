/**
 * Тесты расчёта DIN.
 *
 * ⚠️ Проверяется КОД и диапазон, а не точное значение: точную цифру
 * выставляет техник по таблице своего крепления. Тесты закрепляют
 * контрольные точки, на которых первая версия модуля ошибалась
 * в 1.5–2 раза — заниженный DIN означает отстёгивание лыжи на
 * скорости.
 */
import { describe, expect, it } from 'vitest'
import {
  DIN_CHART_VERSION,
  filterByWaistWidth,
  needsWideBoard,
  recommendDin,
} from '~/domain/fitting/din'

describe('recommendDin', () => {
  it('взрослый 75 кг: код K, диапазон накрывает 6–7', () => {
    const r = recommendDin({ weight: 75, height: 178, bslMm: 300 })

    expect(r.code).toBe('K')
    expect(r.range![0]).toBeLessThanOrEqual(6)
    expect(r.range![1]).toBeGreaterThanOrEqual(7)
  })

  it('тяжёлый 95 кг: код L, диапазон накрывает 8–9.5', () => {
    const r = recommendDin({ weight: 95, height: 185, bslMm: 320 })

    expect(r.code).toBe('L')
    expect(r.range![0]).toBeLessThanOrEqual(8)
    expect(r.range![1]).toBeGreaterThanOrEqual(9.5)
  })

  it('ребёнок 30 кг: код E, значения детские', () => {
    const r = recommendDin({ weight: 30, height: 135, bslMm: 250 })

    expect(r.code).toBe('E')
    expect(r.range![1]).toBeLessThan(3)
  })

  it('⚠️ рост ограничивает код: берётся МЕНЬШИЙ из двух', () => {
    // Тяжёлый подросток: по весу код L, по росту I.
    const r = recommendDin({ weight: 80, height: 155, bslMm: 290 })

    expect(r.code).toBe('I')
    expect(r.why.join(' ')).toContain('меньший из двух')
  })

  it('возраст вне 10–50 понижает код на шаг', () => {
    const adult = recommendDin({ weight: 75, height: 178, bslMm: 300 })
    const senior = recommendDin({ weight: 75, height: 178, bslMm: 300, age: 62 })

    expect(senior.code).not.toBe(adult.code)
    expect(senior.why.join(' ')).toContain('возраст')
  })

  it('⚠️ без веса расчёта нет вовсе', () => {
    const r = recommendDin({ weight: 0 })

    expect(r.range).toBeNull()
    expect(r.missing).toContain('вес')
  })

  it('без BSL код есть, но подсказка по подошве отсутствует', () => {
    const r = recommendDin({ weight: 75, height: 178 })

    expect(r.code).toBe('K')
    expect(r.bslHint).toBeNull()
    expect(r.missing.join(' ')).toContain('BSL')
  })

  it('⚠️ длинная подошва — НИЖЕ затяжка, а не выше', () => {
    // Самая частая ошибка самодельных калькуляторов: больше рычаг,
    // тот же момент достигается меньшим значением.
    const long = recommendDin({ weight: 75, height: 178, bslMm: 330 })
    const short = recommendDin({ weight: 75, height: 178, bslMm: 270 })

    expect(long.bslHint).toContain('НИЖНЕЙ')
    expect(short.bslHint).toContain('ВЕРХНЕЙ')
  })

  it('версия чартов возвращается всегда', () => {
    // ASTM отменил поправочные коэффициенты — без версии нельзя
    // понять, по каким правилам считали прошлый сезон.
    expect(recommendDin({ weight: 75 }).chartVersion).toBe(DIN_CHART_VERSION)
  })
})

describe('ширина талии', () => {
  it('от EU 44 нужна wide-доска', () => {
    expect(needsWideBoard(43)).toBe(false)
    expect(needsWideBoard(44)).toBe(true)
    expect(needsWideBoard(47)).toBe(true)
  })

  it('⚠️ жёсткий фильтр, а не предпочтение', () => {
    const variants = [
      { code: 'sb-152', attrs: { waistWidthMm: 245 } },
      { code: 'sb-157w', attrs: { waistWidthMm: 262 } },
    ]
    const r = filterByWaistWidth(variants, 45)

    expect(r.fitting.map((v) => v.code)).toEqual(['sb-157w'])
    expect(r.excluded[0]?.why).toContain('заденет склон')
  })

  it('маленькая нога — фильтра нет', () => {
    const variants = [{ code: 'sb-152', attrs: { waistWidthMm: 245 } }]

    expect(filterByWaistWidth(variants, 40).fitting).toHaveLength(1)
    expect(filterByWaistWidth(variants, 40).excluded).toHaveLength(0)
  })

  it('⚠️ если подходящих нет — возвращаем всё, а не отказываем', () => {
    // Отказать клиенту совсем хуже, чем предупредить: решение за
    // стойкой, у которой доска в руках.
    const variants = [{ code: 'sb-152', attrs: { waistWidthMm: 240 } }]
    const r = filterByWaistWidth(variants, 46)

    expect(r.fitting).toHaveLength(1)
  })
})
