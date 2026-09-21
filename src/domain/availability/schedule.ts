/**
 * Часы работы филиала и проверка границ аренды.
 *
 * Нужно, иначе система предложит бронь на время, когда прокат закрыт
 * (../rental-docs/docs/04-тз/10-бэкенд/18-время-и-расписание.md).
 *
 * ⚠️ Проверяются ОБЕ границы. Частая ошибка — проверить только выдачу:
 * тогда возврат попадает на 23:00 закрытого дня, и клиент приезжает
 * к запертой двери.
 *
 * ⚠️ Часы хранятся как ЛОКАЛЬНОЕ время плюс пояс филиала, а не как
 * UTC-момент: правило «каждый день в 10:00» после перевода часов
 * уехало бы на час. В РФ перевода нет, но продукт целится в другие
 * страны.
 */
import type { PoolClient } from 'pg'
import { seasonAllows } from '~/common/contract/season'

export interface ScheduleRow {
  weekday: number | null
  exception_date: string | null
  opens_at: string | null
  closes_at: string | null
  is_closed: boolean
}

export interface BoundaryCheck {
  ok: boolean
  /** Что именно не подошло — для сообщения клиенту. */
  problems: {
    which: 'pickup' | 'return'
    localTime: string
    reason: 'closed_day' | 'outside_hours' | 'off_season'
    opensAt?: string
    closesAt?: string
  }[]
}

/**
 * Локальные дата, время и день недели момента в поясе филиала.
 *
 * ⚠️ Через Intl, а не арифметикой по смещению: смещение меняется при
 * переводе часов, и вычисления по UTC дают сдвиг на сутки на границе.
 */
export function localParts(d: Date, timezone: string): {
  date: string
  time: string
  weekday: number
} {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  })

  const parts: Record<string, string> = {}
  for (const p of fmt.formatToParts(d)) parts[p.type] = p.value

  // en-GB даёт 24-часовой формат; полночь приходит как «24», не «00».
  const hour = parts.hour === '24' ? '00' : parts.hour

  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  }

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${hour}:${parts.minute}`,
    weekday: weekdayMap[parts.weekday ?? 'Mon'] ?? 1,
  }
}

/** «HH:MM» → минуты от полуночи. Для сравнения без разбора Date. */
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

/**
 * Правило на конкретную дату.
 *
 * ⚠️ Исключение (праздник, санитарный день) ПЕРЕКРЫВАЕТ правило дня
 * недели: иначе 1 января будет работать как обычная пятница.
 */
export function ruleForDate(
  rows: ScheduleRow[],
  localDate: string,
  weekday: number,
): ScheduleRow | null {
  const exception = rows.find((r) => r.exception_date === localDate)
  if (exception) return exception
  return rows.find((r) => r.exception_date === null && r.weekday === weekday) ?? null
}

/**
 * Проверяет, что выдача и возврат попадают в часы работы.
 *
 * Отсутствие расписания трактуется как «работает круглосуточно», а не
 * как «закрыто»: иначе прокат, не заполнивший расписание, не сможет
 * принять ни одного заказа — а система обязана работать при небрежном
 * заполнении данных.
 */
export async function checkBusinessHours(
  c: PoolClient,
  opts: { branchId: string, from: Date, to: Date, timezone: string },
): Promise<BoundaryCheck> {
  const problems: BoundaryCheck['problems'] = []

  // ⚠️ Период работы филиала — ОТДЕЛЬНАЯ ось от сезона категории:
  // «зимний прокат летом закрыт целиком». Проверяется до расписания
  // по дням недели: если филиал закрыт на сезон, часы не имеют смысла.
  const { rows: br } = await c.query<{ season_from_month: number | null, season_to_month: number | null }>(
    `SELECT season_from_month, season_to_month FROM branch WHERE id = $1`,
    [opts.branchId],
  )
  const branchSeason = { fromMonth: br[0]?.season_from_month ?? null, toMonth: br[0]?.season_to_month ?? null }
  if (!seasonAllows(opts.from, branchSeason, opts.timezone)) {
    const { date, time } = localParts(opts.from, opts.timezone)
    problems.push({ which: 'pickup', localTime: `${date} ${time}`, reason: 'off_season' })
    return { ok: false, problems }
  }

  const { rows } = await c.query<ScheduleRow>(
    `SELECT weekday, exception_date::text, opens_at, closes_at, is_closed
     FROM schedule WHERE branch_id = $1`,
    [opts.branchId],
  )

  if (rows.length === 0) return { ok: true, problems: [] }

  for (const [which, moment] of [
    ['pickup', opts.from] as const,
    ['return', opts.to] as const,
  ]) {
    const { date, time, weekday } = localParts(moment, opts.timezone)
    const rule = ruleForDate(rows, date, weekday)

    // Нет правила на этот день — ограничений нет.
    if (!rule) continue

    if (rule.is_closed) {
      problems.push({ which, localTime: `${date} ${time}`, reason: 'closed_day' })
      continue
    }

    if (!rule.opens_at || !rule.closes_at) continue

    const t = toMinutes(time)
    const open = toMinutes(rule.opens_at)
    const close = toMinutes(rule.closes_at)

    // ⚠️ Граница закрытия включительна: вернуть ровно в 22:00 можно,
    // это и есть «до 22:00». Открытие тоже включительно.
    if (t < open || t > close) {
      problems.push({
        which,
        localTime: `${date} ${time}`,
        reason: 'outside_hours',
        opensAt: rule.opens_at,
        closesAt: rule.closes_at,
      })
    }
  }

  return { ok: problems.length === 0, problems }
}

/**
 * Расширяет интервал брони буфером на подготовку.
 *
 * ⚠️ Буфер реализуется РАСШИРЕНИЕМ диапазона, а не изменением
 * оператора пересечения (железное правило №4). Полуоткрытый интервал
 * [начало, конец) означает, что возврат в 15:00 и выдача в 15:00 не
 * конфликтуют — физически же клиент вернул мокрый сноуборд, и его
 * в ту же секунду отдают следующему.
 *
 * Буфер задаётся по КАТЕГОРИИ: ботинкам нужна просушка, перчаткам
 * ничего. По умолчанию 0 — прокат работает без настройки.
 */
export function applyBuffer(to: Date, bufferMinutes: number): Date {
  if (!bufferMinutes) return to
  return new Date(to.getTime() + bufferMinutes * 60_000)
}

/** Часы работы филиала для показа клиенту. */
export async function branchSchedule(
  c: PoolClient,
  branchId: string,
): Promise<ScheduleRow[]> {
  const { rows } = await c.query<ScheduleRow>(
    `SELECT weekday, exception_date::text, opens_at, closes_at, is_closed
     FROM schedule WHERE branch_id = $1
     ORDER BY exception_date NULLS FIRST, weekday`,
    [branchId],
  )
  return rows
}
