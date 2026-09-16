/**
 * Подбор размера по параметрам тела.
 *
 * Главный дифференциатор продукта: конкуренты собирают параметры,
 * но не превращают их в конкретную единицу инвентаря
 * (../rental-docs/docs/04-тз/00-общее/03-домен.md, 05-рынок.md).
 *
 * ⚠️ Подбор ПРЕДЛАГАЕТ, а не решает: клиент видит объяснение и может
 * изменить. Иначе система, ошибившись, теряет клиента.
 */

import { applyTable, type FitRow } from './fit-rules'

export interface BodyParams {
  height?: number
  weight?: number
  shoeSizeEu?: number
  headCircumference?: number
}

export interface FitSuggestion {
  variantCode: string
  /** Объяснение для клиента: видно, откуда цифра. */
  why: string
  /** Уверенность: exact — по формуле, fallback — на стойке подберут. */
  confidence: 'exact' | 'fallback'
}

/**
 * Длина сноуборда.
 *
 * ⚠️ Ведущий параметр — ВЕС, а не рост: вес определяет прогиб доски
 * под нагрузкой. Это самая частая ошибка моделирования.
 * Старт ≈90% роста, дальше корректировка по весу.
 *
 * Уровень катания не спрашивается (решение владельца), поэтому
 * берётся консервативный вариант: короче — проще управлять.
 */
export function fitSnowboard(p: BodyParams): number | null {
  if (!p.height || !p.weight) return null

  let length = Math.round(p.height * 0.9)

  // Корректировка по весу: ±1 см на каждые 4.5 кг отклонения
  // от «нормального» веса для этого роста (грубая оценка ИМТ 22).
  const expectedWeight = 22 * (p.height / 100) ** 2
  length += Math.round((p.weight - expectedWeight) / 4.5)

  // Консервативно: минус 2 см, потому что уровень неизвестен.
  length -= 2

  return Math.max(140, Math.min(170, length))
}

/**
 * Mondopoint из размера обуви EU.
 *
 * Mondopoint — это длина стопы в сантиметрах. Спрашиваем EU, потому
 * что длину стопы в см почти никто не знает.
 *
 * ⚠️ Половинные размеры делят одну колодку: 26.0 и 26.5 — та же
 * скорлупа, разный внутренник. Значит реальная гранулярность
 * склада — 1 см, а не 0.5.
 */
export function euToMondo(eu: number): number {
  return Math.round((eu - 2) * 0.667 * 2) / 2
}

/**
 * Размер шлема по обхвату головы.
 *
 * ⚠️ Из роста НЕ выводится: корреляция r≈0.30–0.44, R²≈0.09–0.20.
 * Рост объясняет 9–20% разброса при шаге размера 4 см — угадывание
 * попадает меньше чем в половине случаев, а неплотный шлем не держит
 * удар. Нет обхвата → пул без размера, подбор на стойке.
 */
export function fitHelmet(p: BodyParams): 'S' | 'M' | 'L' | null {
  const c = p.headCircumference
  if (!c) return null
  if (c < 55) return 'S'
  if (c < 59) return 'M'
  return 'L'
}

/**
 * Подбирает варианты под параметры.
 *
 * Возвращает предложения с объяснением; отсутствие подбора для
 * категории — не ошибка, а `fallback`: подберут на стойке.
 *
 * ⚠️ Таблица тенанта, если она заведена, имеет ПРИОРИТЕТ над встроенной
 * формулой (13.10). Это и есть обещание «правила подбора — данные»:
 * у каждого проката своя политика (новичку короче), и менять её он
 * должен без нашего релиза. Встроенные формулы остаются умолчанием —
 * пустая таблица не означает «подбора нет», иначе система переставала
 * бы работать при небрежном заполнении данных.
 */
export function suggest(
  categories: { code: string, variants: { code: string, bucket: Record<string, unknown> }[] }[],
  p: BodyParams,
  /** Таблицы тенанта по коду категории: код категории → строки. */
  tables?: Map<string, FitRow[]>,
): FitSuggestion[] {
  const out: FitSuggestion[] = []

  for (const cat of categories) {
    // Своя таблица проката проверяется ПЕРВОЙ.
    const table = tables?.get(cat.code)
    if (table?.length) {
      const value = applyTable(table, p as Record<string, number | undefined>)
      const fit = value ? cat.variants.find((v) => v.code === value) : undefined
      if (fit) {
        out.push({
          variantCode: fit.code,
          // ⚠️ Клиенту сообщается, что подбор по правилам проката:
          // если он спорит с результатом, разговаривать надо со стойкой,
          // а не с нами.
          why: 'по таблице подбора проката',
          confidence: 'exact',
        })
        continue
      }
      // Таблица есть, но не дала попадания — падаем на встроенную
      // формулу, а не отказываем: строка могла не покрыть крайний рост.
    }

    if (cat.code === 'snowboard' || cat.code === 'sup') {
      const target = cat.code === 'snowboard' ? fitSnowboard(p) : null

      if (cat.code === 'sup' && p.weight) {
        // Сапборд подбирается по весу: у каждой доски предел.
        const fit = cat.variants.find((v) => Number(v.bucket.maxWeight ?? 0) >= p.weight!)
        if (fit) {
          out.push({
            variantCode: fit.code,
            why: `по весу ${p.weight} кг`,
            confidence: 'exact',
          })
        }
        continue
      }

      if (target) {
        const fit = cat.variants.find((v) => {
          const min = Number(v.bucket.lengthMin ?? 0)
          const max = Number(v.bucket.lengthMax ?? 0)
          return target >= min && target <= max
        }) ?? nearestByLength(cat.variants, target)

        if (fit) {
          out.push({
            variantCode: fit.code,
            why: `по росту ${p.height} см и весу ${p.weight} кг`,
            confidence: 'exact',
          })
        }
      }
      continue
    }

    if (cat.code === 'boots' && p.shoeSizeEu) {
      const fit = cat.variants.find((v) => Number(v.bucket.eu ?? 0) === p.shoeSizeEu)
        ?? nearestByEu(cat.variants, p.shoeSizeEu)
      if (fit) {
        out.push({
          variantCode: fit.code,
          why: `из размера обуви ${p.shoeSizeEu} EU`,
          confidence: 'exact',
        })
      }
      continue
    }

    if (cat.code === 'helmet') {
      const size = fitHelmet(p)
      if (size) {
        const fit = cat.variants.find((v) => v.code.endsWith(size.toLowerCase()))
        if (fit) {
          out.push({
            variantCode: fit.code,
            why: `по обхвату головы ${p.headCircumference} см`,
            confidence: 'exact',
          })
        }
      } else {
        // ⚠️ Обхват не дали — не угадываем. Берём средний размер
        // и честно говорим, что подберут на стойке.
        const fallback = cat.variants.find((v) => v.code.endsWith('m')) ?? cat.variants[0]
        if (fallback) {
          out.push({
            variantCode: fallback.code,
            why: 'размер подберём на стойке',
            confidence: 'fallback',
          })
        }
      }
      continue
    }

    // Остальные категории (перчатки) — без подбора.
    const first = cat.variants[0]
    if (first) {
      out.push({ variantCode: first.code, why: 'размер уточним на стойке', confidence: 'fallback' })
    }
  }

  return out
}

function nearestByLength(
  variants: { code: string, bucket: Record<string, unknown> }[],
  target: number,
) {
  return variants
    .map((v) => ({
      v,
      dist: Math.abs(((Number(v.bucket.lengthMin ?? 0) + Number(v.bucket.lengthMax ?? 0)) / 2) - target),
    }))
    .sort((a, b) => a.dist - b.dist)[0]?.v
}

function nearestByEu(
  variants: { code: string, bucket: Record<string, unknown> }[],
  target: number,
) {
  return variants
    .map((v) => ({ v, dist: Math.abs(Number(v.bucket.eu ?? 0) - target) }))
    .sort((a, b) => a.dist - b.dist)[0]?.v
}
