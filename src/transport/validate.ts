/**
 * Валидация на границе — единственное место, где непроверенные данные
 * превращаются в типизированный вход сценария.
 *
 * ⚠️ Схема обязательна, и это не стиль. Фреймворк проверяет типы
 * ОТВЕТОВ, но никогда тел запросов: «типизированный fetch» — не контракт.
 * Непроверенные данные, дошедшие до домена, — именно тот баг, ради
 * которого правило существует.
 *
 * ⚠️ valibot, а не JSON Schema родного Fastify: схемы уже написаны
 * (80 эндпоинтов), и в них живёт нормализация — канонизация телефона
 * происходит там же, где проверка. Переписывать их на другой валидатор
 * значит переписать и нормализацию, потеряв по дороге ровно то, что
 * она предотвращает (`plans/03-API.md`).
 */
import * as v from 'valibot'
import { apiError } from '../kernel/errors'

/**
 * Разбирает вход по схеме или бросает VALIDATION_FAILED с путями полей.
 *
 * ⚠️ Пути возвращаются клиенту намеренно: форма показывает ошибку рядом
 * с полем, а не общим «неверные данные» наверху экрана.
 */
export function parse<S extends v.GenericSchema>(schema: S, input: unknown): v.InferOutput<S> {
  const parsed = v.safeParse(schema, input)
  if (!parsed.success) {
    throw apiError('VALIDATION_FAILED', 'Неверные данные', {
      issues: parsed.issues.map((i) => ({
        path: i.path?.map((p) => String((p as { key?: unknown }).key)).join('.'),
        message: i.message,
      })),
    })
  }
  return parsed.output
}
