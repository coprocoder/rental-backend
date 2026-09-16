/**
 * Подсчёт дней аренды — функция от режима тенанта.
 *
 * ⚠️ Три модели дают РАЗНЫЕ счета на одном заказе, поэтому это не
 * «разница дат в часах», а отдельная функция, которую спрашивают все
 * правила цены. См. ../rental-docs/docs/04-тз/10-бэкенд/18-время-и-расписание.md.
 *
 * Пример расхождения: взял в пятницу 18:00, вернул в воскресенье 12:00.
 *   calendar     → 3 (пт, сб, вс)
 *   rolling24    → 2 (42 часа = 2 полных суток)
 *   business_day → 2 (сб, вс; пятничный вечер — отдельный тариф)
 *
 * При 800 ₽/день разброс — 1200 ₽.
 */

export type DayMode = 'calendar' | 'rolling24' | 'business_day'

/**
 * Считает количество расчётных дней в интервале.
 *
 * ⚠️ Граничный случай: аренда внутри одного дня (взял 10:00, вернул 18:00)
 * — это 1 день во всех трёх моделях. Без явной обработки легко получить 0.
 *
 * @param from начало аренды
 * @param to конец аренды
 * @param mode режим тенанта
 * @param timezone часовой пояс ФИЛИАЛА (не тенанта и не браузера)
 */
export function countRentalDays(
  from: Date,
  to: Date,
  mode: DayMode,
  timezone: string,
): number {
  if (to <= from) return 0

  switch (mode) {
    case 'rolling24': {
      // Полные сутки от момента выдачи. Неполный остаток — ещё один день:
      // клиент пользовался вещью, значит платит.
      const hours = (to.getTime() - from.getTime()) / 3_600_000
      return Math.max(1, Math.ceil(hours / 24))
    }

    case 'calendar':
    case 'business_day': {
      // Считаем затронутые календарные дни в поясе филиала.
      // business_day отличается не подсчётом дней, а тем, что неполный
      // вечер получает скидку отдельным правилом цены — смешивать
      // подсчёт дней со скидками нельзя.
      const a = localDayNumber(from, timezone)
      const b = localDayNumber(to, timezone)
      return Math.max(1, b - a + 1)
    }
  }
}

/**
 * Номер дня от эпохи в заданном часовом поясе.
 *
 * ⚠️ Через Intl, а не через смещение в миллисекундах: смещение меняется
 * при переходе на летнее время, и арифметика по UTC даёт сдвиг на сутки
 * на границе перевода часов. В РФ перевода нет, но продукт целится
 * в другие страны.
 */
export function localDayNumber(d: Date, timezone: string): number {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  // en-CA даёт YYYY-MM-DD — устойчивый к локали формат.
  const [y, m, day] = fmt.format(d).split('-').map(Number)
  return Math.floor(Date.UTC(y!, m! - 1, day!) / 86_400_000)
}

/**
 * Календарный день со сдвигом в N дней, в поясе ФИЛИАЛА.
 *
 * ⚠️ Наивный способ молча неверен:
 *
 *   const d = new Date(); d.setDate(d.getDate() + n)
 *   d.toISOString().slice(0, 10)
 *
 * Сдвиг делается в поясе БРАУЗЕРА, а срез строки берёт день в UTC —
 * это разные календари. Клиент в Красноярске (+7) с полуночи до 07:00
 * местного времени получал вчерашний день: календарь предлагал нижней
 * границей уже прошедшую дату, а «завтра» по умолчанию оказывалось
 * сегодня. Тот же класс ошибки, что описан в day-instant.ts.
 *
 * @param offset   сдвиг в днях: 0 — сегодня, 1 — завтра
 * @param timezone пояс ФИЛИАЛА, не браузера и не сервера
 * @param at       момент отсчёта; параметр ради тестируемости
 */
export function isoDayIn(offset: number, timezone: string, at: Date = new Date()): string {
  // Через номер дня: арифметика идёт по целым суткам в UTC, поэтому
  // не зависит ни от пояса машины, ни от переходов на летнее время.
  const n = localDayNumber(at, timezone) + offset
  return new Date(n * 86_400_000).toISOString().slice(0, 10)
}

/**
 * Раскрывает интервал в список календарных дат в поясе филиала.
 *
 * ⚠️ Нужно для заполнения pool_day: бронь с 1 по 5 число должна занять
 * КАЖДЫЙ день, включая промежуточные. Иначе 2–4 останутся «свободными»,
 * и вещь будет продана дважды.
 */
export function expandToDays(from: Date, to: Date, timezone: string): string[] {
  const out: string[] = []
  const start = localDayNumber(from, timezone)
  const end = localDayNumber(to, timezone)

  for (let n = start; n <= end; n++) {
    const d = new Date(n * 86_400_000)
    out.push(d.toISOString().slice(0, 10))
  }
  return out
}
