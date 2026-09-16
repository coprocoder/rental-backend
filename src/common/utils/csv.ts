/**
 * Разбор CSV для импорта инвентаря (13.5).
 *
 * ⚠️ Разбор идёт НА КЛИЕНТЕ и предзаполняет форму, а не пишет в БД
 * (13.5). Причина в том, как выглядят реальные файлы прокатов: колонки
 * названы по-своему, единицы разные, половина строк — заголовки
 * разделов. Импорт «сразу в базу» на таком файле создаёт мусор, который
 * потом вычищают руками дольше, чем заводили бы вручную. Предзаполненная
 * форма даёт человеку увидеть, что получилось, до записи.
 *
 * ⚠️ Нераспознанное ПОМЕЧАЕТСЯ, а не отбрасывается (13.5.0): выброшенная
 * молча строка — это позиция, которой не будет на складе, и заметят её
 * в разгар сезона.
 *
 * ⚠️ Свой разбор, а не библиотека: нужен ровно один формат, а зависимость
 * ради двадцати строк — это лишние килобайты и лишний повод обновляться.
 * Кавычки и переводы строк внутри поля учтены: их дают все выгрузки
 * из Excel.
 */

/** Строки как массивы ячеек. Разделитель определяется по первой строке. */
export function parseCsv(text: string): string[][] {
  // ⚠️ BOM снимается: Excel добавляет его в UTF-8, и первый заголовок
  // перестаёт совпадать с ожидаемым именем колонки — по невидимому символу.
  // \uFEFF записан escape-последовательностью, а не самим символом:
  // невидимый символ в исходнике — это ровно тот класс ошибок, от
  // которого мы здесь и защищаемся.
  const src = text.replace(/^\uFEFF/, '')

  // ⚠️ Разделитель угадывается: русский Excel пишет ; а не , потому что
  // запятая занята десятичным разделителем. Файл из него — обычный случай.
  const firstLine = src.slice(0, src.indexOf('\n') === -1 ? undefined : src.indexOf('\n'))
  const delim = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0)
    ? ';'
    : ','

  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]

    if (quoted) {
      if (ch === '"') {
        // Удвоенная кавычка внутри поля — это одна кавычка.
        if (src[i + 1] === '"') { field += '"'; i++ } else { quoted = false }
      } else {
        field += ch
      }
      continue
    }

    if (ch === '"') { quoted = true } else if (ch === delim) {
      row.push(field); field = ''
    } else if (ch === '\n') {
      row.push(field); field = ''
      rows.push(row); row = []
    } else if (ch !== '\r') {
      field += ch
    }
  }

  if (field || row.length) { row.push(field); rows.push(row) }

  // Полностью пустые строки выкидываются: в выгрузках их всегда хвост.
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''))
}

/** Что мы умеем понимать в колонке. */
export type ColumnRole = 'code' | 'name' | 'category' | 'qty' | 'size' | 'price' | 'ignore'

/**
 * Догадка о роли колонки по её заголовку.
 *
 * ⚠️ Именно ДОГАДКА, и она показывается человеку для правки (13.5.0):
 * автоматическое сопоставление ошибается на «размер» (обуви? доски?)
 * и на «цена» (за день? залог?), а цена ошибки — испорченный прайс.
 */
export function guessRole(header: string): ColumnRole {
  const h = header.toLowerCase().trim()
  if (/арт|код|code|sku/.test(h)) return 'code'
  if (/кол|шт|qty|quantity|остат/.test(h)) return 'qty'
  if (/катег|тип|group|categ/.test(h)) return 'category'
  if (/разм|size|ростов/.test(h)) return 'size'
  if (/цена|price|стоим/.test(h)) return 'price'
  if (/наим|назв|name|товар|модель/.test(h)) return 'name'
  return 'ignore'
}

interface ImportRow {
  code: string
  name: string
  category: string
  size: string
  qty: number | null
  price: string
  /** Что не удалось понять — показывается, а не отбрасывается. */
  problems: string[]
}

/**
 * Строки файла → строки формы по выбранному сопоставлению колонок.
 *
 * ⚠️ Строка с непонятным количеством НЕ выбрасывается, а помечается
 * проблемой: решает человек. Отбросить её значило бы потерять позицию
 * молча.
 */
export function toRows(cells: string[][], mapping: ColumnRole[]): ImportRow[] {
  const out: ImportRow[] = []

  for (const line of cells) {
    const get = (role: ColumnRole): string => {
      const idx = mapping.indexOf(role)
      return idx >= 0 ? (line[idx] ?? '').trim() : ''
    }

    const rawQty = get('qty')
    // Запятая как десятичный разделитель: «1,0» из русского Excel.
    const qty = rawQty ? Number(rawQty.replace(',', '.').replace(/\s/g, '')) : NaN

    const problems: string[] = []
    const name = get('name')
    const code = get('code')

    if (!name && !code) problems.push('нет ни названия, ни кода')
    if (rawQty && !Number.isFinite(qty)) problems.push(`количество «${rawQty}» не число`)
    if (!rawQty) problems.push('количество не указано')
    if (!get('category')) problems.push('категория не указана')

    out.push({
      code,
      name,
      category: get('category'),
      size: get('size'),
      qty: Number.isFinite(qty) ? qty : null,
      price: get('price'),
      problems,
    })
  }

  return out
}
