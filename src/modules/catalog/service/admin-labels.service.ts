/**
 * Лист меток для печати: номер и QR на каждую единицу.
 *
 * ⚠️ Отдаём ГОТОВУЮ СТРАНИЦУ, а не картинки по одной: прокат печатает
 * пачку наклеек на лист, и собирать её из отдельных запросов в браузере
 * значит получить разъехавшуюся вёрстку при печати.
 *
 * ⚠️ QR содержит ТОЛЬКО номер единицы, никогда не команду и не ссылку
 * на действие. Метка наклеена на вещь и физически доступна клиенту;
 * ссылка, меняющая статус по факту открытия, не имеет автора
 * (железное правило 13) и срабатывала бы от превью в мессенджере.
 *
 * ⚠️ Рядом с QR печатается человекочитаемый номер: метка стирается и
 * мокнет, а система обязана работать при стёртой метке — сотрудник
 * вводит номер руками (правило 12).
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import QRCode from 'qrcode'
import { listItems } from '~/domain/inventory/items'

/**
 * Экранирование для вставки в HTML: названия приходят от тенанта.
 *
 * ⚠️ Своя копия, а не импорт из `~/transport/html`: `transport` —
 * верхний слой, сервисы в него не ходят (правило `transport-is-top`).
 * Четыре строки дублирования дешевле дырки в границе слоёв.
 */
function esc(s: string): string {
  return s.replace(/[&<>"]/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] as string))
}

export interface GetLabelsInput {
  query: Record<string, unknown>
}

export async function getLabels(
  session: Session,
  req: GetLabelsInput,
  deps: Deps,
) {
  const q = req.query
  const variantId = typeof q.variantId === 'string' ? q.variantId : undefined

  const all = session.activeRole === 'owner' || session.activeRole === 'admin'

  const items = await deps.db.tx(session.tenantId, (c) => listItems(c, {
    tenantId: session.tenantId,
    variantId,
    branchIds: all ? [] : session.branchIds,
  }))

  const cells = await Promise.all(items.map(async (i) => {
    const svg = await QRCode.toString(i.labelCode, {
      type: 'svg',
      margin: 0,
      // ⚠️ Коррекция M: метка на прокатной вещи трётся и мокнет,
      // а L не переживёт первого сезона.
      errorCorrectionLevel: 'M',
    })
    return `<div class="l">
      <div class="q">${svg}</div>
      <div class="t">
        <b>${esc(i.labelCode)}</b>
        <span>${esc(i.categoryName)} · ${esc(i.variantName)}</span>
      </div>
    </div>`
  }))
  // ⚠️ Страница не индексируется и не кэшируется: это внутренний
  // документ конкретного проката.

  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<title>Метки — ${items.length} шт</title>
<style>
  body { font: 13px/1.3 system-ui, sans-serif; margin: 12mm; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6mm; }
  .l { display: flex; gap: 3mm; align-items: center; border: 1px dashed #bbb;
       padding: 3mm; border-radius: 2mm; break-inside: avoid; }
  .q { width: 18mm; height: 18mm; flex: none; }
  .q svg { width: 100%; height: 100%; display: block; }
  .t { display: flex; flex-direction: column; gap: 1mm; min-width: 0; }
  .t b { font-size: 14px; letter-spacing: 0.02em; }
  .t span { font-size: 10px; color: #555; overflow-wrap: anywhere; }
  .head { margin-bottom: 6mm; }
  @media print { .head { display: none; } body { margin: 6mm; } }
</style></head>
<body>
  <div class="head">
    <b>Меток: ${items.length}</b> — печатайте на самоклеящемся листе,
    затем наклейте по номеру. Номер продублирован текстом: стёртая метка
    не должна останавливать работу.
  </div>
  <div class="grid">${cells.join('')}</div>
</body></html>`
}
