/**
 * Лимиты бронирования — защита инвентаря от блокировки.
 *
 * Из ТЗ (../rental-docs/docs/04-тз/10-бэкенд/12-наличие-и-жизненный-цикл.md): проблема не в
 * том, что брони существуют, а в том, что бронь без обязательства
 * ничего не стоит клиенту. Требовать предоплату нельзя — невозвратные
 * брони в РФ незаконны, а прокаты работают с наличными на месте.
 *
 * ⚠️ Лимита позиций в заказе по умолчанию НЕТ. Любое число, выбранное
 * «на глаз», режет честные крупные заказы, а какой заказ у реального
 * проката честный, заранее неизвестно. Защиту дают механизмы, не
 * зависящие от размера заказа: доля пула, дедлайн подтверждения,
 * глубина вперёд.
 *
 * ⚠️ Здесь только ПРАВИЛА, без SQL: чистые функции проверяются без базы,
 * а чтение живёт в `../database/limits.repository.ts`.
 */
import type { Limits, LimitViolation } from '../pricing.types'

export const DEFAULT_LIMITS: Limits = {
  poolSharePercent: 30,
  maxActiveOrders: 5,
  maxAdvanceDays: 90,
  confirmDeadlineHours: 24,
  holdMinutes: 20,
}

/**
 * Сколько единиц варианта доступно одному заказу.
 *
 * ⚠️ Считается от ЁМКОСТИ варианта, а не от свободного остатка: иначе
 * лимит слабеет по мере заполнения — когда защита нужнее всего.
 *
 * ⚠️ Округление ВВЕРХ: при ёмкости 3 и доле 30% одну единицу взять
 * можно. Иначе мелкие пулы становятся вообще недоступны, что не защита,
 * а отказ в обслуживании.
 */
export function allowedShare(capacity: number, sharePercent: number): number {
  return Math.max(1, Math.ceil((capacity * sharePercent) / 100))
}

/**
 * Проверка доли пула по уже прочитанной ёмкости.
 *
 * ⚠️ Чистая функция: ёмкость приходит параметром, а не читается здесь.
 * Поэтому правило «30% от ёмкости, но не меньше единицы» проверяется
 * таблицей случаев за миллисекунды, а не поднятой базой.
 */
export function checkPoolShare(opts: {
  variantId: string
  qty: number
  capacity: number
  sharePercent: number
}): LimitViolation | null {
  // Ёмкость 0 — вариант вне поштучного учёта; доля к нему неприменима.
  if (opts.capacity === 0) return null

  const allowed = allowedShare(opts.capacity, opts.sharePercent)
  if (opts.qty <= allowed) return null

  return {
    kind: 'pool_share',
    variantId: opts.variantId,
    requested: opts.qty,
    allowed,
    capacity: opts.capacity,
  }
}
