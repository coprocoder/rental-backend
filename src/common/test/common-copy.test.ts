/**
 * `shared/` существует в ДВУХ копиях, и этот тест — единственное, что
 * держит их вместе.
 *
 * ⚠️ Копия появилась потому, что выбран отдельный репозиторий, а не
 * монорепо (`plans/06-ЭТАПЫ.md`, C1). Там живут матрица прав, тарифы,
 * подсчёт дней аренды и канонизация телефона — деньги и доступ.
 *
 * ⚠️ Расхождение НЕ проявляется как ошибка. Оно проявляется поведением:
 * клиент, заведённый дважды из-за разного формата телефона, и обойдённый
 * лимит активных броней. Поэтому проверка автоматическая, а не «не
 * забыть поправить в обоих местах».
 *
 * ⚠️ Тест удаляется вместе с долгом — когда `shared` станет общим пакетом.
 * Не раньше: до тех пор он и есть механизм, заменяющий пакет.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const theirs = join(here, '../../../../rental/shared')

/**
 * Копия разложена по назначению (`contract/` и `utils/`), а оригинал
 * лежит одним плоским каталогом. Сверяем по ИМЕНАМ файлов, а не по
 * путям: раскладка — наше дело, содержимое — общее.
 *
 * ⚠️ `i18n-field.ts` в сверку не входит: он наш, во фронтовом `shared`
 * его нет — там он жил в `server/utils/`.
 */
const OURS: Record<string, string> = Object.fromEntries(
  ['contract', 'utils'].flatMap((sub) =>
    readdirSync(join(here, '..', sub))
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => [f, join(here, '..', sub, f)]),
  ),
)

function modulesOf(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .sort()
}

describe('копии общего кода не разошлись', () => {
  it('состав модулей совпадает', () => {
    // ⚠️ Если оригинал недоступен (сборка вне рабочей копии), тест
    // обязан упасть, а не притвориться зелёным: молчаливый пропуск
    // ровно здесь и означал бы, что долг перестал контролироваться.
    const ours = Object.keys(OURS).filter((f) => f !== 'i18n-field.ts').sort()

    expect(modulesOf(theirs)).toEqual(ours)
  })

  it.each(modulesOf(theirs))('%s совпадает с оригиналом дословно', (file) => {
    const ourPath = OURS[file]
    expect(ourPath, `${file} потерян при раскладке по contract/utils`).toBeTruthy()

    expect(readFileSync(ourPath as string, 'utf8'))
      .toBe(readFileSync(join(theirs, file), 'utf8'))
  })
})
