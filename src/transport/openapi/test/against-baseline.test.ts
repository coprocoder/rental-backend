/**
 * Схемы ответов сверяются с НАСТОЯЩИМИ ответами API.
 *
 * ⚠️ Смысл всей затеи. Документация, живущая отдельно от кода,
 * расходится с ним за месяц — и тогда она хуже её отсутствия: по ней
 * пишут интеграции. Схема, которую никто не проверяет против реального
 * ответа, ровно такая же документация.
 *
 * ⚠️ Сопоставление АВТОМАТИЧЕСКОЕ, по карте `urls.json`: новый
 * описанный роут подхватывается сам, без правки списка здесь. Ручной
 * список устаревал бы молча — и тест тихо перестал бы что-либо
 * проверять.
 *
 * ⚠️ Схема неверна И ТОГДА, когда она ШИРЕ ответа: поле, объявленное
 * обязательным и отсутствующее в ответе, — это будущая ошибка на
 * фронте, где типы обещают то, чего нет.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import { documentedRoutes } from '../registry'
import '../../../modules/registry'

const BASELINE = resolve(process.cwd(), '../rental/test/api/baseline')
const urls = JSON.parse(readFileSync(resolve(BASELINE, 'urls.json'), 'utf8')) as Record<string, string>

/** `/api/v1/admin/orders/5f44…` → `/v1/admin/orders/:id` */
function normalize(url: string): string {
  return url
    .replace(/^\/api/, '')
    .replace(/\?.*$/, '')
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '/:id')
}

/** Эталонные файлы, отвечающие роуту: их может быть несколько. */
function filesFor(path: string): string[] {
  return Object.entries(urls)
    .filter(([, url]) => normalize(url) === path)
    .map(([name]) => name)
    .filter((name) => existsSync(resolve(BASELINE, `${name}.json`)))
}

const documented = documentedRoutes().filter((r) => r.method === 'get')

describe('схемы ответов не расходятся с API', () => {
  for (const route of documented) {
    const files = filesFor(route.path)
    // ⚠️ Роут без эталона пропускается, а не падает: POST-ы эталон
    // не снимает вовсе, и требовать его здесь значило бы запретить
    // описывать мутации.
    if (!files.length) continue

    for (const file of files) {
      it(`${route.path} ← ${file}`, () => {
        const body = JSON.parse(readFileSync(resolve(BASELINE, `${file}.json`), 'utf8')) as Record<string, unknown>

        // ⚠️ Эталон хранит и ОТКАЗЫ: `admin/blackout` без обязательного
        // `variantId` отвечает 422, и это зафиксировано как правильное
        // поведение. Схема успеха с конвертом ошибки совпадать не должна
        // и не обязана.
        if (body && typeof body === 'object' && 'error' in body) return

        const parsed = v.safeParse(route.response, body)
        if (!parsed.success) {
          // Путь до поля важнее текста: «categories.0.variants.3.price»
          // сразу называет место расхождения.
          const where = parsed.issues
            .map((i) => `${i.path?.map((p) => String((p as { key?: unknown }).key)).join('.')}: ${i.message}`)
            .join('\n  ')
          expect.fail(`схема разошлась с ответом:\n  ${where}`)
        }
      })
    }
  }

  it('⚠️ сверка реально что-то проверяет, а не пропускает всё', () => {
    // Защита от тихого вырождения: если сопоставление сломается,
    // все тесты выше просто исчезнут — и файл останется зелёным.
    const covered = documented.filter((r) => filesFor(r.path).length)
    expect(covered.length, 'описанных GET-роутов с эталоном').toBeGreaterThanOrEqual(5)
  })
})

describe('реестр', () => {
  it('в каждом описании есть сводка и схема ответа', () => {
    for (const r of documentedRoutes()) {
      expect(r.summary.length, `${r.path}: пустая сводка`).toBeGreaterThan(10)
      expect(r.response, `${r.path}: нет схемы ответа`).toBeTruthy()
    }
  })
})
