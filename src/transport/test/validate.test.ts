/**
 * ⚠️ Тест про КОНКРЕТНЫЙ дефект, а не про валидатор вообще.
 * `?variantId=` (пустое значение незаполненного фильтра) уезжало в SQL
 * как UUID, Postgres отвечал 22P02, наружу выходило 500 «Внутренняя
 * ошибка» на `admin/items`, `admin/labels` и `counter/orders`.
 */
import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import { optionalId, parse } from '../validate'

const Query = v.object({ variantId: optionalId })

describe('optionalId', () => {
  it('пустая строка — это «фильтра нет», а не идентификатор', () => {
    // ⚠️ Ровно то, что слал браузер за незаполненный фильтр.
    expect(parse(Query, { variantId: '' })).toEqual({ variantId: undefined })
  })

  it('отсутствующий параметр — тоже «фильтра нет»', () => {
    expect(parse(Query, {})).toEqual({ variantId: undefined })
  })

  it('валидный UUID проходит как есть', () => {
    const id = 'e2e51572-e741-48c3-92d0-db7b4732e3fc'
    expect(parse(Query, { variantId: id })).toEqual({ variantId: id })
  })

  it('мусор — это отказ 422, а не 500 от базы', () => {
    // ⚠️ `?variantId=не-uuid` роняло сервер так же, как пустая строка.
    expect(() => parse(Query, { variantId: 'не-uuid' })).toThrowError()
    try {
      parse(Query, { variantId: 'не-uuid' })
    } catch (e) {
      expect((e as { code?: string }).code).toBe('VALIDATION_FAILED')
    }
  })
})
