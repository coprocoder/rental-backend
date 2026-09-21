/**
 * Мелочи для ответов, которые читает ЧЕЛОВЕК в браузере, а не код.
 *
 * ⚠️ Не в `common/utils`: тот каталог копируется на фронт и сверяется
 * дословным тестом, а экранирование разметки — забота стороны, которая
 * эту разметку отдаёт.
 */

/** Экранирование для вставки в HTML: текст приходит от тенанта. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] as string))
}

/**
 * Хочет ли клиент разметку.
 *
 * ⚠️ По `Accept`, а не по параметру в адресе: браузер по ссылке всегда
 * просит `text/html`, а `fetch` из кода — нет. Так один и тот же адрес
 * остаётся и документом для человека, и JSON для виджета, который
 * встраивается в чужие сайты. Менять форму ответа для всех было
 * нельзя — это публичный API.
 */
export function wantsHtml(accept: string | undefined): boolean {
  return (accept ?? '').includes('text/html')
}

/**
 * Страница с юридическим документом.
 *
 * ⚠️ Читаемость здесь не косметика: под этим текстом человек ставит
 * подпись, нажимая «соглашаюсь». Раньше эндпоинт отдавал JSON, и по
 * ссылке из формы открывалось `{"version":"v1","text":"⚠️ ТИПОВАЯ…`
 * с экранированными переносами строк (19.44).
 *
 * ⚠️ `white-space: pre-wrap` — текст хранится с переносами и отступами,
 * и они значимы: нумерация пунктов договора держится на них.
 */
export function documentPage(opts: {
  title: string
  version: string
  text: string
}): string {
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<style>
  body { font: 15px/1.6 system-ui, -apple-system, sans-serif; color: #1a1a1a;
         margin: 0; padding: 32px 20px 64px; background: #fff; }
  main { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 20px; letter-spacing: -.02em; margin: 0 0 4px; }
  .v { color: #666; font-size: 13px; margin: 0 0 24px; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; margin: 0; }
  @media print { body { padding: 0; } .v { color: #000; } }
</style>
</head><body><main>
<h1>${escapeHtml(opts.title)}</h1>
<p class="v">Редакция ${escapeHtml(opts.version)}</p>
<pre>${escapeHtml(opts.text)}</pre>
</main></body></html>`
}
