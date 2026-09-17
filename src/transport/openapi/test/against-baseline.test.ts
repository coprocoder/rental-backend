/**
 * Схемы ответов сверяются с НАСТОЯЩИМИ ответами API.
 *
 * ⚠️ Смысл всей затеи. Документация, живущая отдельно от кода,
 * расходится с ним за месяц — и тогда она хуже её отсутствия: по ней
 * пишут интеграции. Схема, которую никто не проверяет против реального
 * ответа, ровно такая же документация.
 *
 * ⚠️ Сверяемся с эталоном (`../rental/test/api/baseline/`), а не
 * с живым сервером: эталон снят с работающего API и обновляется
 * осознанно, поэтому тест не требует поднятого стенда и не зависит
 * от данных в момент прогона.
 *
 * ⚠️ Схема неверна И ТОГДА, когда она ШИРЕ ответа: поле, объявленное
 * обязательным и отсутствующее в ответе, — это будущая ошибка на
 * фронте, где типы обещают то, чего нет.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import { documentedRoutes } from '../registry'
import '../../../modules/registry'

const BASELINE = resolve(process.cwd(), '../rental/test/api/baseline')

function baseline(name: string): unknown {
  return JSON.parse(readFileSync(resolve(BASELINE, `${name}.json`), 'utf8'))
}

/** Какие эталонные файлы каким роутам соответствуют. */
const CASES: { route: string, files: string[] }[] = [
  {
    route: '/v1/public/catalog',
    files: ['public/catalog', 'public/catalog__summer', 'public/catalog__locale_en'],
  },
]

describe('схемы ответов не расходятся с API', () => {
  for (const { route, files } of CASES) {
    for (const file of files) {
      it(`${route} ← ${file}`, () => {
        const doc = documentedRoutes().find((r) => r.path === route)
        expect(doc, `роут ${route} должен быть описан`).toBeTruthy()

        const parsed = v.safeParse(doc!.response, baseline(file))
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
})

describe('реестр', () => {
  it('в каждом описании есть сводка и схема ответа', () => {
    for (const r of documentedRoutes()) {
      expect(r.summary.length, `${r.path}: пустая сводка`).toBeGreaterThan(10)
      expect(r.response, `${r.path}: нет схемы ответа`).toBeTruthy()
    }
  })
})
