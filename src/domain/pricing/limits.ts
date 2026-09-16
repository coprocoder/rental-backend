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
 * зависящие от размера заказа:
 *
 *   доля пула           один клиент не выносит вариант целиком,
 *                       сколько бы позиций ни просил (30% по умолчанию);
 *   дедлайн подтверждения удержать много позиций стоит действий;
 *   глубина вперёд      бронь на год вперёд блокирует сезон.
 *
 * Всё настраивается тенантом: значения по умолчанию — не константы кода.
 */
import type { PoolClient } from 'pg'
import { localDayNumber } from '~/common/contract/day-count'

export interface Limits {
  poolSharePercent: number
  maxActiveOrders: number
  maxAdvanceDays: number
  confirmDeadlineHours: number
  holdMinutes: number
}

const DEFAULTS: Limits = {
  poolSharePercent: 30,
  maxActiveOrders: 5,
  maxAdvanceDays: 90,
  confirmDeadlineHours: 24,
  holdMinutes: 20,
}

/** Настройки тенанта. Отсутствие строки — значения по умолчанию. */
export async function getLimits(c: PoolClient, tenantId: string): Promise<Limits> {
  const { rows } = await c.query<{
    pool_share_percent: number
    max_active_orders: number
    max_advance_days: number
    confirm_deadline_hours: number
    hold_minutes: number
  }>(
    `SELECT pool_share_percent, max_active_orders, max_advance_days,
            confirm_deadline_hours, hold_minutes
     FROM booking_limit WHERE tenant_id = $1`,
    [tenantId],
  )
  const r = rows[0]
  if (!r) return DEFAULTS

  return {
    poolSharePercent: r.pool_share_percent,
    maxActiveOrders: r.max_active_orders,
    maxAdvanceDays: r.max_advance_days,
    confirmDeadlineHours: r.confirm_deadline_hours,
    holdMinutes: r.hold_minutes,
  }
}

export type LimitViolation =
  | { kind: 'pool_share', variantId: string, requested: number, allowed: number, capacity: number }
  | { kind: 'active_orders', current: number, allowed: number }
  | { kind: 'advance_days', requested: number, allowed: number }

/**
 * Доля пула, доступная одному заказу.
 *
 * ⚠️ Считается от ЁМКОСТИ варианта, а не от свободного остатка: иначе
 * лимит слабеет по мере заполнения — когда защита нужнее всего.
 *
 * Подтверждённая практика: в myTurn есть ровно такая настройка
 * «максимальный процент инвентаря, который можно зарезервировать».
 */
export async function checkPoolShare(
  c: PoolClient,
  opts: { tenantId: string, variantId: string, qty: number, sharePercent: number },
): Promise<LimitViolation | null> {
  const { rows } = await c.query<{ capacity: number }>(
    `SELECT MAX(capacity)::int AS capacity FROM pool_day
     WHERE tenant_id = $1 AND variant_id = $2`,
    [opts.tenantId, opts.variantId],
  )
  const capacity = rows[0]?.capacity ?? 0
  if (capacity === 0) return null

  // Округление вверх: при ёмкости 3 и доле 30% одну единицу взять можно.
  // Иначе мелкие пулы становятся вообще недоступны, что не защита,
  // а отказ в обслуживании.
  const allowed = Math.max(1, Math.ceil((capacity * opts.sharePercent) / 100))
  if (opts.qty <= allowed) return null

  return { kind: 'pool_share', variantId: opts.variantId, requested: opts.qty, allowed, capacity }
}

/**
 * Число одновременных активных броней на клиента.
 *
 * ⚠️ Считается по ТЕЛЕФОНУ: он и так обязателен, а без привязки к
 * личности счётчик сбрасывается новой почтой за минуту.
 */
export async function checkActiveOrders(
  c: PoolClient,
  opts: { tenantId: string, phone: string, allowed: number },
): Promise<LimitViolation | null> {
  const { rows } = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n
     FROM rental_order o
     JOIN customer cu ON cu.id = o.customer_id
     WHERE o.tenant_id = $1
       AND cu.phone = $2
       AND o.status IN ('awaiting_stock', 'awaiting_confirm', 'confirmed', 'issued',
                        'partially_returned', 'overdue')`,
    [opts.tenantId, opts.phone],
  )
  const current = rows[0]?.n ?? 0
  if (current < opts.allowed) return null

  return { kind: 'active_orders', current, allowed: opts.allowed }
}

/**
 * Глубина бронирования вперёд.
 *
 * ⚠️ Считается в днях по календарю ФИЛИАЛА, а не в часах: «за 90 дней»
 * для человека означает календарные дни.
 */
export function checkAdvanceDays(
  opts: { from: Date, now: Date, timezone: string, allowed: number },
): LimitViolation | null {
  const days = localDayNumber(opts.from, opts.timezone)
    - localDayNumber(opts.now, opts.timezone)
  if (days <= opts.allowed) return null

  return { kind: 'advance_days', requested: days, allowed: opts.allowed }
}

/** Человекочитаемое сообщение о нарушении. */
export function describeViolation(v: LimitViolation): string {
  switch (v.kind) {
    case 'pool_share':
      return `Одному заказу доступно не больше ${v.allowed} шт. этой позиции`
    case 'active_orders':
      return `У вас уже ${v.current} активных броней — это максимум`
    case 'advance_days':
      return `Бронировать можно не больше чем на ${v.allowed} дней вперёд`
  }
}
