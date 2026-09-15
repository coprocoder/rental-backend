/**
 * Конверт ошибки и отображение кодов БД.
 */
import { describe, expect, it } from 'vitest'
import { ApiError, apiError, isApiError, mapDbError } from '../errors'

describe('apiError', () => {
  it('код определяет статус, а не вызывающий', () => {
    expect(apiError('ITEM_JUST_TAKEN', 'занято').statusCode).toBe(409)
    expect(apiError('PLAN_REQUIRED', 'тариф').statusCode).toBe(402)
    expect(apiError('NOT_FOUND', 'нет').statusCode).toBe(404)
  })

  it('тело ответа — ровно документированный конверт', () => {
    expect(apiError('POOL_EXHAUSTED', 'не хватает', { variantId: 'v1' }).toBody()).toEqual({
      error: { code: 'POOL_EXHAUSTED', message: 'не хватает', details: { variantId: 'v1' } },
    })
  })

  it('без подробностей поля details в конверте нет', () => {
    expect(apiError('NOT_FOUND', 'нет').toBody()).toEqual({
      error: { code: 'NOT_FOUND', message: 'нет' },
    })
  })

  /**
   * ⚠️ Почему класс, а не объект с полем `code`: у ошибок драйвера `pg`
   * поле `code` тоже есть. Утиная проверка приняла бы `23505` за код API
   * и отдала бы его клиенту как имя ошибки.
   */
  it('ошибка pg не притворяется ошибкой API', () => {
    expect(isApiError(Object.assign(new Error('dup'), { code: '23505' }))).toBe(false)
    expect(isApiError(apiError('NOT_FOUND', 'нет'))).toBe(true)
    expect(isApiError(new TypeError('boom'))).toBe(false)
  })

  it('остаётся обычной ошибкой: instanceof Error и стек на месте', () => {
    const e = apiError('INTERNAL', 'ой')
    expect(e).toBeInstanceOf(Error)
    expect(e).toBeInstanceOf(ApiError)
    expect(e.stack).toBeTruthy()
  })
})

describe('mapDbError', () => {
  /**
   * ⚠️ 23P01 — самая частая ошибка в воронке бронирования. Она обязана
   * быть не «500», а ответом с альтернативами: иначе клиент уходит.
   */
  it('нарушение EXCLUDE превращается в понятный клиенту отказ', () => {
    const mapped = mapDbError(Object.assign(new Error('conflict'), { code: '23P01' }))

    expect(isApiError(mapped)).toBe(true)
    expect((mapped as ApiError).code).toBe('ITEM_JUST_TAKEN')
    expect((mapped as ApiError).statusCode).toBe(409)
  })

  /**
   * ⚠️ Отличие от Nuxt-версии, и оно намеренное. Там 23514 (ЛЮБОЙ CHECK)
   * переводился в «на выбранные даты не хватает свободных единиц».
   * Это уже стоило дефекта: CHECK сработал на ПРАЙСЕ, а прокат увидел
   * сообщение про склад на экране про деньги (19.23). Общее отображение
   * слишком грубое — CHECK ловится на месте вызова, где известно, какое
   * правило нарушено.
   */
  it('CHECK НЕ переводится огульно в «не хватает единиц»', () => {
    const err = Object.assign(new Error('check violation'), { code: '23514' })

    expect(mapDbError(err)).toBe(err)
    expect(isApiError(mapDbError(err))).toBe(false)
  })

  it('незнакомая ошибка возвращается как есть, а не маскируется', () => {
    const err = new TypeError('boom')
    expect(mapDbError(err)).toBe(err)
  })
})
