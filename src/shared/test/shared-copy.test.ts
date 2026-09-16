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
const ours = join(here, '..')
const theirs = join(here, '../../../../rental/shared')

/** Только модули, без тестов и вспомогательных каталогов. */
function modulesOf(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .sort()
}

describe('копии shared не разошлись', () => {
  const our = modulesOf(ours)

  it('состав модулей совпадает', () => {
    // ⚠️ Если оригинал недоступен (сборка вне рабочей копии), тест
    // обязан упасть, а не притвориться зелёным: молчаливый пропуск
    // ровно здесь и означал бы, что долг перестал контролироваться.
    expect(modulesOf(theirs)).toEqual(our)
  })

  it.each(modulesOf(ours))('%s совпадает с оригиналом дословно', (file) => {
    const a = readFileSync(join(ours, file), 'utf8')
    const b = readFileSync(join(theirs, file), 'utf8')

    expect(a).toBe(b)
  })
})
