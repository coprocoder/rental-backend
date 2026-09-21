/**
 * Таблицы подбора как данные (13.10).
 *
 * ⚠️ Главное здесь — полуоткрытые границы и запрет пересечений. Оба
 * про одно: подбор не должен зависеть от порядка строк в выборке.
 * С включительными границами рост ровно 170 попадает в две строки
 * сразу, и какой размер получит клиент, решает случайность.
 */
import { describe, expect, it } from 'vitest'
import { applyTable, type FitRow } from '~/domain/fitting/fit-rules'
import { suggest } from '~/domain/fitting/fitting'

const TABLE: FitRow[] = [
  { param: 'height', min: 150, max: 170, value: 'sb-147' },
  { param: 'height', min: 170, max: 200, value: 'sb-157' },
]

describe('applyTable', () => {
  it('нижняя граница включительна', () => {
    expect(applyTable(TABLE, { height: 150 })).toBe('sb-147')
    expect(applyTable(TABLE, { height: 170 })).toBe('sb-157')
  })

  it('верхняя граница НЕ включительна: 170 уходит в следующую строку', () => {
    // ⚠️ Ради этого всё и сделано полуоткрытым: иначе 170 подходит
    // и к первой строке, и ко второй.
    expect(applyTable(TABLE, { height: 169 })).toBe('sb-147')
    expect(applyTable(TABLE, { height: 170 })).toBe('sb-157')
  })

  it('вне диапазонов — null, а не ближайшее', () => {
    // ⚠️ Не угадываем: вызывающий должен решить сам, падать ли на
    // встроенную формулу. Молчаливое «ближайшее» скрыло бы дыру
    // в таблице проката.
    expect(applyTable(TABLE, { height: 140 })).toBeNull()
    expect(applyTable(TABLE, { height: 220 })).toBeNull()
  })

  it('отсутствующий параметр пропускается, а не считается нулём', () => {
    // Иначе клиент без роста получил бы самую короткую доску.
    expect(applyTable(TABLE, {})).toBeNull()
    expect(applyTable(TABLE, { height: undefined, weight: 75 })).toBeNull()
  })
})

describe('suggest с таблицей тенанта', () => {
  const cats = [{
    code: 'snowboard',
    variants: [
      { code: 'sb-147', bucket: { lengthMin: 145, lengthMax: 149 } },
      { code: 'sb-157', bucket: { lengthMin: 155, lengthMax: 159 } },
    ],
  }]

  it('таблица проката перекрывает встроенную формулу', () => {
    const tables = new Map([['snowboard', TABLE]])
    const [s] = suggest(cats, { height: 175, weight: 75 }, tables)
    expect(s?.variantCode).toBe('sb-157')
    expect(s?.why).toContain('таблице подбора проката')
  })

  it('без таблицы работает встроенная формула — пустота не отключает подбор', () => {
    // ⚠️ Это и есть «система работает при небрежном заполнении данных»:
    // прокат не завёл таблицу — подбор всё равно есть.
    const [s] = suggest(cats, { height: 175, weight: 75 })
    expect(s).toBeDefined()
    expect(s?.why).not.toContain('таблице подбора проката')
  })

  it('промах по таблице падает на формулу, а не отказывает', () => {
    // Строка могла не покрыть крайний рост — отказывать из-за этого
    // значило бы потерять клиента на дыре в чужой таблице.
    const tables = new Map([['snowboard', TABLE]])
    const [s] = suggest(cats, { height: 210, weight: 95 }, tables)
    expect(s).toBeDefined()
    expect(s?.why).not.toContain('таблице подбора проката')
  })
})
