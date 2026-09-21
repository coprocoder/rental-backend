/**
 * Поиск заказа по строке: код брони, хвост телефона или имя клиента.
 *
 * ⚠️ ОДНО место на весь проект. Условие повторялось в admin.ts и counter.ts
 * с разными номерами параметров, и это не косметика: правило «что считается
 * совпадением» обязано быть одинаковым в админке и на стойке. Разойдясь,
 * они дают разный ответ на один и тот же запрос — сотрудник на стойке
 * находит заказ, а администратор нет.
 *
 * ⚠️ Хвост телефона, а не полный номер: клиент у стойки называет последние
 * цифры, полный номер он не диктует вслух при очереди за спиной.
 */

/** Строка поиска и её цифровая часть — телефон клиент называет с разделителями. */
export interface OrderSearchTerm {
  /** Исходная строка без краёв: код брони и имя ищутся по ней. */
  q: string
  /** Только цифры: хвост телефона. Пустая строка — цифр не было. */
  digits: string
}

export function orderSearchTerm(raw: string | undefined): OrderSearchTerm {
  const q = raw?.trim() ?? ''
  return { q, digits: q.replace(/\D/g, '') }
}

/**
 * SQL-условие поиска. Принимает номера плейсхолдеров, потому что у вызовов
 * разное число предшествующих параметров — вписывать их руками означало бы
 * вернуть тот же дубль.
 *
 * @param qParam     номер параметра со строкой поиска ($5)
 * @param digitsParam номер параметра с цифрами ($6)
 * @param orderAlias алиас таблицы rental_order в запросе
 * @param customerAlias алиас таблицы customer
 */
export function orderSearchSql(
  qParam: number,
  digitsParam: number,
  orderAlias = 'o',
  customerAlias = 'cu',
): string {
  return `(
         $${qParam} = ''
         OR upper(${orderAlias}.public_code) = upper($${qParam})
         OR ($${digitsParam} <> '' AND ${customerAlias}.phone LIKE '%' || $${digitsParam})
         OR ${customerAlias}.name ILIKE '%' || $${qParam} || '%'
       )`
}
