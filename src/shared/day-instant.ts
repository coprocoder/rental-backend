/**
 * Календарный день + время в поясе филиала → момент времени (ISO).
 *
 * ⚠️ Обратная операция к localDayNumber, и нужна ровно потому, что
 * наивный способ молча неверен:
 *
 *   new Date(`${день}T10:00:00`)   // разбирается в поясе БРАУЗЕРА
 *
 * Филиал в Красноярске, клиент из Москвы — и на сервер уходит момент,
 * сдвинутый на четыре часа. Уезжает всё: цена (правило «после 17:00
 * −30%»), наличие (границы tstzrange) и проверка часов работы.
 * Ошибка не видна ни в одном серверном тесте: сервер получает
 * синтаксически правильный ISO, просто не тот.
 *
 * Через Intl, а не через арифметику со смещением: смещение меняется при
 * переходе на летнее время. В РФ перевода нет, но продукт целится
 * в другие страны, и день перевода — это ровно тот день, когда прокат
 * работает, а система врёт.
 */

/**
 * Смещение пояса в минутах для конкретного момента.
 *
 * Считается по разнице между тем, как момент выглядит в UTC и в целевом
 * поясе. Единственный способ узнать смещение с учётом летнего времени,
 * не таская базу правил.
 */
function offsetMinutes(at: Date, timezone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  })
  const p: Record<string, string> = {}
  for (const part of fmt.formatToParts(at)) p[part.type] = part.value
  // en-US в 24-часовом формате отдаёт полночь как «24».
  const hour = p.hour === '24' ? '00' : p.hour
  const asUtc = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(hour), Number(p.minute), Number(p.second),
  )
  return (asUtc - at.getTime()) / 60_000
}

/**
 * @param day      календарная дата «YYYY-MM-DD» в поясе филиала
 * @param time     «HH:MM» в поясе филиала
 * @param timezone пояс ФИЛИАЛА, не браузера и не сервера
 * @returns момент в ISO (UTC)
 */
export function dayTimeToInstant(day: string, time: string, timezone: string): string {
  const [y, m, d] = day.split('-').map(Number)
  const [hh, mm] = time.split(':').map(Number)
  if (!y || !m || !d) throw new Error(`Некорректная дата: ${day}`)

  // Первое приближение — тот же час в UTC.
  const guess = Date.UTC(y, m - 1, d, hh ?? 0, mm ?? 0)
  // Смещение на момент приближения, затем поправка.
  const off = offsetMinutes(new Date(guess), timezone)
  const exact = guess - off * 60_000

  // ⚠️ Второй проход: если приближение попало по другую сторону перевода
  // часов, смещение было взято не то. Пересчёт по уточнённому моменту
  // сходится, потому что переводы бывают раз в полгода, а не каждый час.
  const off2 = offsetMinutes(new Date(exact), timezone)
  return new Date(off2 === off ? exact : guess - off2 * 60_000).toISOString()
}
