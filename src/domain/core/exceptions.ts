/**
 * Нештатные ситуации: продление, просрочка, передача, повреждение.
 *
 * Обоснования — ../rental-docs/docs/04-тз/10-бэкенд/19-нештатные-ситуации.md.
 *
 * ⚠️ Общий принцип: удержание за повреждение — это ВОЗМЕЩЕНИЕ УЩЕРБА,
 * а не штраф. Требует акта с описанием и заранее опубликованного прайса
 * на ущерб, иначе оспоримо. Плата за просрочку законна по той же
 * логике — это фактическое пользование сверх срока, в отличие от
 * штрафа за неявку, который незаконен.
 */
import type { PoolClient } from 'pg'
import { checkAvailability, reservePool } from '../availability/availability'
import { applyBuffer } from '../availability/schedule'
import { audit, transition } from './order-lifecycle'
import { recordRefusal } from '../availability/demand'
import { apiError } from '~/kernel/errors'
import { countRentalDays, type DayMode } from '~/common/contract/day-count'

export interface ExtendResult {
  ok: boolean
  newEndsAt?: Date
  /** Доплата за продление, посчитанная по СНИМКУ правил заказа. */
  surcharge?: string
  /** Что мешает продлить, если нельзя. */
  blockedBy?: { variantId: string, shortageDays: string[] }[]
}

/**
 * Продление аренды посередине.
 *
 * Частый и приятный сценарий — клиент хочет оставить снаряжение ещё
 * на день. Возможен удалённо, по ссылке, без визита на стойку.
 *
 * ⚠️ Цена доплаты считается по СНИМКУ правил заказа, а не по текущему
 * прайсу: иначе продление подорожало бы из-за смены цен, которую
 * клиент не выбирал.
 *
 * ⚠️ Наличие проверяется на НОВЫЙ интервал: вещь может быть уже
 * забронирована другим, и продление «по умолчанию» создало бы двойную
 * бронь.
 */
export async function extendRental(
  c: PoolClient,
  opts: {
    tenantId: string
    orderId: string
    newEndsAt: Date
    actorStaffId?: string
  },
): Promise<ExtendResult> {
  const { rows } = await c.query<{
    status: string
    starts_at: Date
    ends_at: Date
    total_amount: string | null
    price_breakdown: { breakdown?: { variantId: string, unitTotal: string, days: number }[] } | null
    branch_id: string
    timezone: string
    day_mode: DayMode
  }>(
    `SELECT o.status, lower(o.period) AS starts_at, upper(o.period) AS ends_at,
            o.total_amount, o.price_breakdown,
            o.branch_pickup_id AS branch_id, b.timezone, t.day_mode
     FROM rental_order o
     JOIN branch b ON b.id = o.branch_pickup_id
     JOIN tenant t ON t.id = o.tenant_id
     WHERE o.id = $1 AND o.tenant_id = $2`,
    [opts.orderId, opts.tenantId],
  )
  const order = rows[0]
  if (!order) throw apiError('NOT_FOUND', 'Заказ не найден')

  // Продлевать можно только действующую аренду.
  if (!['confirmed', 'issued', 'partially_returned', 'overdue'].includes(order.status)) {
    throw apiError('INVALID_STATE', 'Этот заказ нельзя продлить', { status: order.status })
  }
  if (opts.newEndsAt.getTime() <= order.ends_at.getTime()) {
    throw apiError('VALIDATION_FAILED', 'Новая дата должна быть позже текущей')
  }

  const { rows: lines } = await c.query<{
    id: string
    variant_id: string
    qty: number
    buffer_minutes: number
  }>(
    `SELECT l.id, l.variant_id, l.qty, cat.buffer_minutes
     FROM order_line l
     JOIN inventory_variant v ON v.id = l.variant_id
     JOIN category cat ON cat.id = v.category_id
     WHERE l.order_id = $1 AND l.status NOT IN ('cancelled', 'returned', 'lost')
     ORDER BY l.variant_id`,
    [opts.orderId],
  )

  // Проверяем только ДОБАВЛЯЕМЫЙ отрезок: старый уже занят этим же
  // заказом, и проверка целого интервала показала бы конфликт с самим
  // собой.
  const blockedBy: { variantId: string, shortageDays: string[] }[] = []
  for (const l of lines) {
    const a = await checkAvailability(c, {
      tenantId: opts.tenantId,
      variantId: l.variant_id,
      from: order.ends_at,
      to: applyBuffer(opts.newEndsAt, l.buffer_minutes),
      timezone: order.timezone,
      qty: l.qty,
    })
    if (!a.available) {
      blockedBy.push({ variantId: l.variant_id, shortageDays: a.shortageDays })
    }
  }

  if (blockedBy.length) {
    // Отказ в продлении — тоже неудовлетворённый спрос: клиент готов
    // платить, а вещи нет. Для закупки это сильный сигнал.
    for (const b of blockedBy) {
      await recordRefusal(c, {
        tenantId: opts.tenantId,
        branchId: order.branch_id,
        variantId: b.variantId,
        reason: 'no_availability',
        from: order.ends_at,
        to: opts.newEndsAt,
      })
    }
    return { ok: false, blockedBy }
  }

  // Занимаем добавленный отрезок.
  for (const l of lines) {
    await reservePool(c, {
      tenantId: opts.tenantId,
      variantId: l.variant_id,
      from: order.ends_at,
      to: applyBuffer(opts.newEndsAt, l.buffer_minutes),
      timezone: order.timezone,
      qty: l.qty,
    })
  }

  // Доплата: считаем добавленные дни по цене за день из снимка.
  const snapshot = order.price_breakdown?.breakdown ?? []
  const oldDays = countRentalDays(order.starts_at, order.ends_at, order.day_mode, order.timezone)
  const newDays = countRentalDays(order.starts_at, opts.newEndsAt, order.day_mode, order.timezone)
  const addedDays = Math.max(0, newDays - oldDays)

  let surchargeKop = 0
  for (const l of lines) {
    const snap = snapshot.find((sn) => sn.variantId === l.variant_id)
    if (!snap || !snap.days) continue
    const perDayKop = Math.round(Number(snap.unitTotal) * 100 / snap.days)
    surchargeKop += perDayKop * addedDays * l.qty
  }
  const surcharge = (surchargeKop / 100).toFixed(2)

  await c.query(
    `UPDATE rental_order
     SET period = tstzrange(lower(period), $2),
         total_amount = COALESCE(total_amount, 0) + $3
     WHERE id = $1`,
    [opts.orderId, opts.newEndsAt, surcharge],
  )
  await c.query(
    `UPDATE order_line
     SET period = tstzrange(lower(period), $2)
     WHERE order_id = $1 AND status NOT IN ('cancelled', 'returned', 'lost')`,
    [opts.orderId, opts.newEndsAt],
  )

  // Просроченный заказ после продления снова в норме.
  if (order.status === 'overdue') {
    await c.query(
      `UPDATE rental_order SET status = 'issued' WHERE id = $1`,
      [opts.orderId],
    )
  }

  await c.query(
    `INSERT INTO event
       (tenant_id, aggregate_type, aggregate_id, kind, payload, actor_type, actor_id)
     VALUES ($1, 'rental_order', $2, 'order.extended', $3, $4, $5)`,
    [opts.tenantId, opts.orderId,
     JSON.stringify({ newEndsAt: opts.newEndsAt.toISOString(), addedDays, surcharge }),
     opts.actorStaffId ? 'staff' : 'customer', opts.actorStaffId ?? null],
  )

  return { ok: true, newEndsAt: opts.newEndsAt, surcharge }
}

/**
 * Плата за просрочку.
 *
 * ⚠️ Законна как фактическое пользование сверх срока — в отличие от
 * штрафа за неявку, который незаконен. Считается по цене за день из
 * снимка, а не по произвольному тарифу: иначе это уже штраф.
 */
export async function overdueCharge(
  c: PoolClient,
  opts: { tenantId: string, orderId: string, now?: Date },
): Promise<{ days: number, amount: string }> {
  const now = opts.now ?? new Date()

  const { rows } = await c.query<{
    ends_at: Date
    price_breakdown: { breakdown?: { variantId: string, unitTotal: string, days: number, qty: number }[] } | null
    day_mode: DayMode
    timezone: string
  }>(
    `SELECT upper(o.period) AS ends_at, o.price_breakdown, t.day_mode, b.timezone
     FROM rental_order o
     JOIN tenant t ON t.id = o.tenant_id
     JOIN branch b ON b.id = o.branch_pickup_id
     WHERE o.id = $1 AND o.tenant_id = $2`,
    [opts.orderId, opts.tenantId],
  )
  const order = rows[0]
  if (!order) throw apiError('NOT_FOUND', 'Заказ не найден')

  if (now.getTime() <= order.ends_at.getTime()) {
    return { days: 0, amount: '0.00' }
  }

  const days = countRentalDays(order.ends_at, now, order.day_mode, order.timezone)
  const snapshot = order.price_breakdown?.breakdown ?? []

  let kop = 0
  for (const snap of snapshot) {
    if (!snap.days) continue
    const perDayKop = Math.round(Number(snap.unitTotal) * 100 / snap.days)
    kop += perDayKop * days * (snap.qty ?? 1)
  }

  return { days, amount: (kop / 100).toFixed(2) }
}

/**
 * Передача брони другому человеку.
 *
 * ⚠️ Это ПЕРЕОФОРМЛЕНИЕ договора, а не «подпись за другого»: договор
 * подписывает тот, кто получает снаряжение, и ответственность несёт
 * получатель. Поэтому его данные попадают в заказ, а прежнее
 * подписание не переносится — новый человек подписывает заново.
 */
export async function transferOrder(
  c: PoolClient,
  opts: {
    tenantId: string
    orderId: string
    newPhone: string
    newName: string
    staffId: string
    reason?: string
  },
): Promise<{ customerId: string }> {
  const { rows: before } = await c.query<{ customer_id: string | null, status: string }>(
    `SELECT customer_id, status FROM rental_order WHERE id = $1 AND tenant_id = $2`,
    [opts.orderId, opts.tenantId],
  )
  const prev = before[0]
  if (!prev) throw apiError('NOT_FOUND', 'Заказ не найден')

  // Выданный заказ передать нельзя: снаряжение уже у первого человека,
  // и это другая операция — возврат плюс новая выдача.
  if (!['awaiting_confirm', 'awaiting_stock', 'confirmed'].includes(prev.status)) {
    throw apiError('INVALID_STATE', 'Передать можно только невыданный заказ', {
      status: prev.status,
    })
  }

  const { rows: cust } = await c.query<{ id: string }>(
    `INSERT INTO customer (tenant_id, phone, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, phone) DO UPDATE SET name = excluded.name
     RETURNING id`,
    [opts.tenantId, opts.newPhone, opts.newName],
  )
  const customerId = cust[0]!.id

  await c.query(
    `UPDATE rental_order SET customer_id = $2 WHERE id = $1`,
    [opts.orderId, customerId],
  )

  // ⚠️ Прежние токены доступа отзываются: ссылка первого человека
  // больше не должна открывать заказ, ставший чужим.
  await c.query(
    `UPDATE order_token SET expires_at = now()
     WHERE order_id = $1 AND expires_at > now()`,
    [opts.orderId],
  )

  await audit(c, {
    tenantId: opts.tenantId,
    staffId: opts.staffId,
    action: 'order.transferred',
    targetType: 'rental_order',
    targetId: opts.orderId,
    reason: opts.reason ?? 'передача брони другому человеку',
    before: { customerId: prev.customer_id },
    after: { customerId },
  })

  await c.query(
    `INSERT INTO event
       (tenant_id, aggregate_type, aggregate_id, kind, payload, actor_type, actor_id)
     VALUES ($1, 'rental_order', $2, 'order.transferred', $3, 'staff', $4)`,
    [opts.tenantId, opts.orderId,
     JSON.stringify({ newPhone: opts.newPhone }), opts.staffId],
  )

  return { customerId }
}

/**
 * Списание вещи.
 *
 * ⚠️ Предупреждает о будущих бронях на этот вариант: списание уменьшает
 * ёмкость, и если на неё уже есть брони, кому-то придётся звонить.
 * Молча уменьшить ёмкость — значит создать двойную бронь задним числом.
 */
export async function writeOffVariant(
  c: PoolClient,
  opts: {
    tenantId: string
    branchId: string
    variantId: string
    qty: number
    staffId: string
    reason: string
    shiftId?: string
  },
): Promise<{ affectedOrders: { publicCode: string, startsAt: Date }[] }> {
  await c.query(
    `INSERT INTO movement
       (tenant_id, branch_id, variant_id, kind, qty, staff_id, shift_id, reason)
     VALUES ($1, $2, $3, 'write_off', $4, $5, $6, $7)`,
    [opts.tenantId, opts.branchId, opts.variantId, -opts.qty,
     opts.staffId, opts.shiftId ?? null, opts.reason],
  )

  // Ёмкость пула уменьшается на будущие дни: иначе система продолжит
  // продавать то, чего нет.
  await c.query(
    `UPDATE pool_day
     SET capacity = GREATEST(0, capacity - $3)
     WHERE tenant_id = $1 AND variant_id = $2 AND day >= current_date`,
    [opts.tenantId, opts.variantId, opts.qty],
  )

  // ⚠️ Кто пострадает: список будущих броней на этот вариант.
  const { rows } = await c.query<{ public_code: string, starts_at: Date }>(
    `SELECT DISTINCT o.public_code, lower(o.period) AS starts_at
     FROM order_line l
     JOIN rental_order o ON o.id = l.order_id
     WHERE l.variant_id = $1
       AND o.status IN ('awaiting_confirm', 'awaiting_stock', 'confirmed')
       AND lower(o.period) >= now()
     ORDER BY starts_at
     LIMIT 20`,
    [opts.variantId],
  )

  await audit(c, {
    tenantId: opts.tenantId,
    staffId: opts.staffId,
    action: 'inventory.write_off',
    targetType: 'inventory_variant',
    targetId: opts.variantId,
    reason: opts.reason,
    after: { qty: opts.qty, affectedOrders: rows.map((r) => r.public_code) },
  })

  return {
    affectedOrders: rows.map((r) => ({
      publicCode: r.public_code,
      startsAt: r.starts_at,
    })),
  }
}

/**
 * Отметка неявки.
 *
 * ⚠️ Пул освобождать вручную НЕ нужно: transition сам это делает,
 * потому что confirmed удерживает инвентарь, а no_show — нет.
 * Ручное освобождение здесь дало бы ДВОЙНОЕ уменьшение qty_booked,
 * и в пуле появились бы «свободные» единицы, которых нет.
 */
export async function markNoShow(
  c: PoolClient,
  opts: { tenantId: string, orderId: string, staffId: string, reason?: string },
): Promise<void> {
  await transition(c, {
    orderId: opts.orderId,
    to: 'no_show',
    actor: { type: 'staff', staffId: opts.staffId, reason: opts.reason },
  })

  // ⚠️ Счётчик неявок — минимум из ТЗ: счётчик, причина, кнопка
  // «снять» у оператора. Политика (пороги, затухание, оспаривание)
  // отложена до данных реального сезона, поля в модели уже есть.
  await c.query(
    `UPDATE customer SET no_show_count = no_show_count + 1
     WHERE id = (SELECT customer_id FROM rental_order WHERE id = $1)`,
    [opts.orderId],
  )
}
