/**
 * Подсказка соседних дат: «в субботу занято, но свободно в пятницу».
 *
 * Развитие листа ожидания (17.14, ../rental-docs/docs/04-тз/10-бэкенд/22-лист-ожидания.md).
 * Отказ без альтернативы — это потерянный клиент; отказ с двумя
 * соседними датами оставляет ему выбор, не требуя заново заполнять
 * форму и гадать, какие дни пробовать.
 *
 * ⚠️ Отдельный модуль, а не ветка в checkAvailability. Наличие
 * отвечает «да/нет на этот интервал» и обязано быть дешёвым: его
 * дёргает каждый расчёт цены. Перебор соседних окон нужен только
 * там, где уже получен отказ, и платить за него на каждом запросе
 * наличия незачем.
 *
 * ⚠️ Сдвиг окна, а не смена длительности. Клиент, попросивший двое
 * суток, хочет двое суток; «возьмите одни» — это не подсказка,
 * а торг. Двигаем начало, длительность держим.
 *
 * ⚠️ Одним запросом на всё окно поиска, а не вызовом checkAvailability
 * на каждого кандидата: при радиусе в неделю это четырнадцать
 * обращений к БД ради строчки, которую человек может и не прочитать.
 */
import type { PoolClient } from 'pg'
import { localDayNumber } from '~/common/contract/day-count'

/** Одно свободное окно той же длительности. */
export interface NearbyWindow {
  /** Начало окна. */
  from: Date
  /** Конец окна, полуоткрытый. */
  to: Date
  /** Сдвиг относительно запрошенного, в сутках. Отрицательный — раньше. */
  shiftDays: number
  /** Свободно в самый тесный день окна. */
  freeUnits: number
}

/**
 * Насколько далеко искать по умолчанию.
 *
 * ⚠️ Неделя, а не месяц: «свободно через три недели» — не подсказка
 * для человека, который приехал на выходные. За пределами недели
 * клиент планирует заново, и ему нужна форма, а не строчка в отказе.
 */
export const NEARBY_RADIUS_DAYS = 7

/** Сколько вариантов показывать. Больше трёх — это уже не подсказка. */
export const NEARBY_LIMIT = 3

const DAY_MS = 86_400_000

/** Дата по номеру дня от эпохи (обратное к localDayNumber). */
function dayText(dayNumber: number): string {
  return new Date(dayNumber * DAY_MS).toISOString().slice(0, 10)
}

/**
 * Ищет ближайшие свободные окна той же длительности.
 *
 * Пусто, если ничего не нашлось. Вызывать имеет смысл только после
 * отказа: в режиме unverified отказа не бывает, значит и подсказывать
 * нечего.
 */
export async function nearbyWindows(
  c: PoolClient,
  opts: {
    variantId: string
    from: Date
    to: Date
    /** Пояс ФИЛИАЛА — тот же, по которому считается наличие. */
    timezone: string
    qty?: number
    radiusDays?: number
    limit?: number
  },
): Promise<NearbyWindow[]> {
  const qty = opts.qty ?? 1
  const radius = opts.radiusDays ?? NEARBY_RADIUS_DAYS
  const limit = opts.limit ?? NEARBY_LIMIT

  // ⚠️ Работаем номерами дней, а не миллисекундами: при переходе на
  // летнее время сутки бывают 23- и 25-часовыми, и «плюс 86400000»
  // однажды даёт тот же день или перескакивает через один.
  const startDay = localDayNumber(opts.from, opts.timezone)
  const endDay = localDayNumber(opts.to, opts.timezone)
  if (endDay < startDay) return []
  const span = endDay - startDay // сколько дней добавляется к началу

  // Окно поиска — запрошенный интервал, раздвинутый радиусом в обе
  // стороны. Один запрос покрывает всех кандидатов сразу.
  const days: string[] = []
  for (let n = startDay - radius; n <= endDay + radius; n++) days.push(dayText(n))

  const { rows } = await c.query<{ day: string, free: number }>(
    `SELECT d::date::text AS day,
            COALESCE(pd.capacity, 0) - COALESCE(pd.qty_booked, 0) AS free
     FROM unnest($2::date[]) AS d
     LEFT JOIN pool_day pd
       ON pd.variant_id = $1 AND pd.day = d::date
     ORDER BY d`,
    [opts.variantId, days],
  )

  const free = new Map(rows.map((r) => [r.day, r.free]))

  // ⚠️ Сдвиги перебираются по возрастанию модуля, и при равном
  // расстоянии раньше идёт более ранняя дата: она ближе к тому,
  // на что клиент уже настроился, и не отодвигает его планы.
  const shifts: number[] = []
  for (let d = 1; d <= radius; d++) shifts.push(-d, d)

  const out: NearbyWindow[] = []

  for (const shift of shifts) {
    // Окно годится, только если хватает В КАЖДЫЙ его день: минимум,
    // а не сумма — та же логика, что в checkAvailability.
    let min = Infinity
    let ok = true
    for (let n = startDay + shift; n <= startDay + shift + span; n++) {
      const f = free.get(dayText(n))
      if (f === undefined || f < qty) { ok = false; break }
      if (f < min) min = f
    }
    if (!ok) continue

    out.push({
      // Время суток сохраняем: клиент просил с 10:00 — предлагаем
      // с 10:00, а не с полуночи. Сдвиг целыми сутками время не трогает
      // (кроме перевода часов, где смещение и должно поехать вместе
      // с местным временем).
      from: new Date(opts.from.getTime() + shift * DAY_MS),
      to: new Date(opts.to.getTime() + shift * DAY_MS),
      shiftDays: shift,
      freeUnits: min,
    })
    if (out.length >= limit) break
  }

  return out
}
