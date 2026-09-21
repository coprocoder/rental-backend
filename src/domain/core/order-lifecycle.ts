/**
 * Жизненный цикл заказа — единственное место, где меняется статус.
 *
 * Схема из ТЗ (../rental-docs/docs/04-тз/10-бэкенд/12-наличие-и-жизненный-цикл.md):
 *
 *   создан → ожидает подтверждения → подтверждён → выдан → возвращён
 *                 ↓ не подтвердил
 *              истёк (автоматически, инвентарь возвращается в пул)
 *
 * Почему всё в одном модуле, а не по обработчикам: у каждого перехода
 * есть три обязательных следствия — запись события в ТОЙ ЖЕ транзакции,
 * освобождение или удержание пула, и запись в audit_log, если переход
 * сделал человек. Разнесённые по эндпоинтам, они рассыхаются: сначала
 * забывается событие, потом пул.
 *
 * ⚠️ Железное правило №13: у каждой автоматики есть ручной эквивалент,
 * и обратный тоже. Поэтому переходы не делятся на «автоматические» и
 * «ручные» — различается только actor, и он всегда записывается.
 */
import type { PoolClient } from 'pg'
import { releasePool, reservePool } from '../availability/availability'
import { applyBuffer } from '../availability/schedule'
import { offerToNextInQueue } from '../availability/waitlist'
import { enqueue } from './outbox'
import { apiError } from '~/kernel/errors'

export type OrderStatus =
  | 'draft'
  | 'awaiting_stock'
  | 'awaiting_confirm'
  | 'confirmed'
  | 'issued'
  | 'partially_returned'
  | 'returned'
  | 'expired'
  | 'no_show'
  | 'cancelled'
  | 'overdue'
  | 'lost'

/** Кто выполнил переход. Для ручных вмешательств обязателен staffId. */
export interface Actor {
  type: 'customer' | 'staff' | 'system'
  staffId?: string
  /** Причина — обязательна для ручных вмешательств, см. audit(). */
  reason?: string
}

/**
 * Допустимые переходы.
 *
 * ⚠️ Таблица нужна именно как данные: без неё «отменить возвращённый
 * заказ» проходит молча и портит статистику, а найти это потом можно
 * только по расхождению отчётов.
 */
const ALLOWED: Record<OrderStatus, OrderStatus[]> = {
  draft: ['awaiting_confirm', 'awaiting_stock', 'cancelled'],
  // Крупный заказ: инвентарь ещё НЕ удержан, оператор проверяет склад.
  awaiting_stock: ['awaiting_confirm', 'confirmed', 'cancelled'],
  awaiting_confirm: ['confirmed', 'expired', 'cancelled'],
  confirmed: ['issued', 'cancelled', 'no_show'],
  issued: ['returned', 'partially_returned', 'overdue', 'lost'],
  partially_returned: ['returned', 'overdue', 'lost'],
  overdue: ['returned', 'partially_returned', 'lost'],
  // Терминальные.
  returned: [],
  expired: [],
  no_show: [],
  cancelled: [],
  lost: [],
}

/** Статусы, при которых инвентарь удерживается в пуле. */
const HOLDS_INVENTORY: OrderStatus[] = [
  'awaiting_confirm',
  'confirmed',
  'issued',
  'partially_returned',
  'overdue',
]

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED[from]?.includes(to) ?? false
}

interface OrderRow {
  id: string
  tenant_id: string
  status: OrderStatus
  period: string
  public_code: string
}

/**
 * Меняет статус заказа со всеми следствиями.
 *
 * Возвращает false, если заказ УЖЕ в целевом статусе — это не ошибка:
 * клиент дважды нажал ссылку подтверждения, обработчик outbox повторил
 * доставку. Идемпотентность здесь обязательна по ТЗ.
 */
export async function transition(
  c: PoolClient,
  opts: {
    orderId: string
    to: OrderStatus
    actor: Actor
    correlationId?: string
    /** Дополнительные поля события: причина отказа, номер смены. */
    payload?: Record<string, unknown>
  },
): Promise<{ changed: boolean, from: OrderStatus, order: OrderRow }> {
  // FOR UPDATE: два одновременных подтверждения не должны разойтись.
  const { rows } = await c.query<OrderRow>(
    `SELECT id, tenant_id, status, period::text, public_code
     FROM rental_order WHERE id = $1 FOR UPDATE`,
    [opts.orderId],
  )
  const order = rows[0]
  if (!order) throw apiError('NOT_FOUND', 'Заказ не найден')

  const from = order.status

  // Повторный вызов того же перехода — успех, а не ошибка.
  if (from === opts.to) {
    return { changed: false, from, order }
  }

  if (!canTransition(from, opts.to)) {
    throw apiError(
      'INVALID_STATE',
      `Из статуса «${from}» нельзя перейти в «${opts.to}»`,
      { from, to: opts.to },
    )
  }

  // ⚠️ Приведение $2 к order_status обязательно: без него параметр
  // выводится и как enum (в SET), и как text (в CASE), и Postgres
  // отказывается — «inconsistent types deduced for parameter».
  await c.query(
    `UPDATE rental_order
     SET status = $2::order_status,
         confirmed_at = CASE WHEN $2::order_status = 'confirmed'
                             THEN now() ELSE confirmed_at END
     WHERE id = $1`,
    [opts.orderId, opts.to],
  )

  // Инвентарь освобождается, если заказ вышел из удерживающих статусов.
  const held = HOLDS_INVENTORY.includes(from)
  const holds = HOLDS_INVENTORY.includes(opts.to)
  if (held && !holds) {
    await releaseOrderInventory(c, order)
  }
  // ⚠️ Обратный случай: awaiting_stock → confirmed. Крупный заказ
  // инвентарь не удерживал, и при подтверждении оператором его надо
  // занять — иначе подтверждённый заказ окажется без брони.
  if (!held && holds) {
    await reserveOrderInventory(c, order)
  }

  // ⚠️ Событие пишется в ТОЙ ЖЕ транзакции, что смена статуса:
  // иначе журнал расходится с состоянием при падении между запросами.
  await c.query(
    `INSERT INTO event
       (tenant_id, aggregate_type, aggregate_id, kind, payload,
        correlation_id, actor_type, actor_id)
     VALUES ($1, 'rental_order', $2, $3, $4, $5, $6, $7)`,
    [
      order.tenant_id,
      order.id,
      `order.${opts.to}`,
      JSON.stringify({ from, to: opts.to, ...opts.payload }),
      opts.correlationId ?? null,
      opts.actor.type,
      opts.actor.staffId ?? null,
    ],
  )

  // ⚠️ Уведомление о подтверждении — ЗДЕСЬ, а не в обработчике ссылки:
  // подтвердить можно двумя путями (клиент по ссылке и оператор
  // в админке), и в каждом из них об отправке пришлось бы помнить
  // отдельно. Обработчик и шаблон order.confirmed были написаны,
  // но в очередь запись не клал НИКТО — клиент нажимал «Подтвердить»
  // и не получал ничего.
  //
  // ⚠️ Только при реальной смене статуса: люди жмут ссылку дважды,
  // и второе нажатие не должно давать второе письмо.
  if (opts.to === 'confirmed') {
    await enqueue(c, {
      tenantId: order.tenant_id,
      kind: 'order.confirmed',
      payload: { orderId: order.id, code: order.public_code },
      // Ключ идемпотентности по заказу: повторный переход в confirmed
      // (например, после возврата в работу) не размножит письма.
      idempotencyKey: `order.confirmed:${order.id}`,
      correlationId: opts.correlationId,
    })
  }

  // Ручное вмешательство — в audit_log с автором и причиной.
  if (opts.actor.type === 'staff') {
    await audit(c, {
      tenantId: order.tenant_id,
      staffId: opts.actor.staffId,
      action: `order.${opts.to}`,
      targetType: 'rental_order',
      targetId: order.id,
      reason: opts.actor.reason,
      before: { status: from },
      after: { status: opts.to },
      correlationId: opts.correlationId,
    })
  }

  // ⚠️ Возвращаем заказ с УЖЕ обновлённым статусом: строка была
  // прочитана до UPDATE, и order.status содержит прежнее значение.
  // Без этого API отдаёт устаревший статус, и стойка после выдачи
  // показывает «подтверждён» вместо «выдан».
  return { changed: true, from, order: { ...order, status: opts.to } }
}

/**
 * Освобождает пул по всем строкам заказа.
 *
 * ⚠️ Дни берутся в отсортированном порядке (внутри releasePool) —
 * единый порядок блокировок на весь код, иначе дедлоки на многодневных
 * бронях (железное правило №14).
 */
async function releaseOrderInventory(c: PoolClient, order: OrderRow): Promise<void> {
  const { rows } = await c.query<{
    variant_id: string
    qty: number
    lower: Date
    upper: Date
    timezone: string
    buffer_minutes: number
  }>(
    // ⚠️ Буфер категории обязателен и здесь: пул занимался расширенным
    // интервалом, и освобождать надо ровно его, иначе после отмены
    // остаются занятые дни, которых никто не бронировал.
    `SELECT l.variant_id, l.qty,
            lower(l.period) AS lower, upper(l.period) AS upper,
            b.timezone, cat.buffer_minutes
     FROM order_line l
     JOIN rental_order o ON o.id = l.order_id
     JOIN branch b ON b.id = o.branch_pickup_id
     JOIN inventory_variant v ON v.id = l.variant_id
     JOIN category cat ON cat.id = v.category_id
     WHERE l.order_id = $1
       AND l.variant_id IS NOT NULL
       AND l.status <> 'cancelled'
     ORDER BY l.variant_id`,
    [order.id],
  )

  for (const r of rows) {
    await releasePool(c, {
      tenantId: order.tenant_id,
      variantId: r.variant_id,
      from: r.lower,
      to: applyBuffer(r.upper, r.buffer_minutes),
      timezone: r.timezone,
      qty: r.qty,
    })

    // ⚠️ Освободившееся сразу предлагается первому в листе ожидания.
    // Именно здесь, а не в обработчике отмены: освободить инвентарь
    // можно отменой, досрочным возвратом и снятием по дедлайну, и
    // каждый новый способ пришлось бы не забыть подключить отдельно.
    await offerToNextInQueue(c, {
      tenantId: order.tenant_id,
      variantId: r.variant_id,
      from: r.lower,
      to: r.upper,
    })
  }
}

/** Занимает пул по строкам заказа — для awaiting_stock → confirmed. */
async function reserveOrderInventory(c: PoolClient, order: OrderRow): Promise<void> {
  const { rows } = await c.query<{
    variant_id: string
    qty: number
    lower: Date
    upper: Date
    timezone: string
    buffer_minutes: number
  }>(
    // ⚠️ Буфер категории обязателен и здесь: пул занимался расширенным
    // интервалом, и освобождать надо ровно его, иначе после отмены
    // остаются занятые дни, которых никто не бронировал.
    `SELECT l.variant_id, l.qty,
            lower(l.period) AS lower, upper(l.period) AS upper,
            b.timezone, cat.buffer_minutes
     FROM order_line l
     JOIN rental_order o ON o.id = l.order_id
     JOIN branch b ON b.id = o.branch_pickup_id
     JOIN inventory_variant v ON v.id = l.variant_id
     JOIN category cat ON cat.id = v.category_id
     WHERE l.order_id = $1
       AND l.variant_id IS NOT NULL
       AND l.status <> 'cancelled'
     ORDER BY l.variant_id`,
    [order.id],
  )

  for (const r of rows) {
    await reservePool(c, {
      tenantId: order.tenant_id,
      variantId: r.variant_id,
      from: r.lower,
      to: applyBuffer(r.upper, r.buffer_minutes),
      timezone: r.timezone,
      qty: r.qty,
    })
  }
}

/**
 * Запись ручного вмешательства.
 *
 * ⚠️ Не для контроля сотрудников, а чтобы через месяц было понятно,
 * почему у этого заказа нестандартные условия (ТЗ, «Ручное
 * администрирование обязательно»).
 */
export async function audit(
  c: PoolClient,
  entry: {
    tenantId: string
    staffId?: string
    action: string
    targetType: string
    targetId?: string
    reason?: string
    before?: unknown
    after?: unknown
    correlationId?: string
  },
): Promise<void> {
  await c.query(
    `INSERT INTO audit_log
       (tenant_id, staff_id, action, target_type, target_id, reason,
        before, after, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      entry.tenantId,
      entry.staffId ?? null,
      entry.action,
      entry.targetType,
      entry.targetId ?? null,
      entry.reason ?? null,
      entry.before ? JSON.stringify(entry.before) : null,
      entry.after ? JSON.stringify(entry.after) : null,
      entry.correlationId ?? null,
    ],
  )
}
