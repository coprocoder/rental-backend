/**
 * Стойка: выдача и возврат.
 *
 * Самая рискованная часть системы (../rental-docs/docs/04-тз/20-фронтенд/24-стойка.md):
 * если стойкой неудобно пользоваться, учёт не ведётся и наличие врёт.
 * Все решения здесь подчинены одному — отметить операцию должно быть
 * быстрее, чем не отметить.
 *
 * ⚠️ Расхождение НЕ блокирует выдачу (железное правило №12). По журналу
 * ноль, а вещь физически лежит — система обязана позволить выдать,
 * зафиксировав расхождение. Интерфейс, говорящий «нельзя, по данным
 * нет», будет выключен в первый же выходной, и тогда бесполезен весь
 * учёт, а не только эта проверка.
 *
 * ⚠️ DIN подтверждает ЧЕЛОВЕК (железное правило №7). Система считает
 * рекомендацию как наряд для техника; в заказ пишется фактически
 * выставленное значение и кто проверил — это след ответственности,
 * а не запись для статистики.
 */
import { orderSearchTerm, orderSearchSql } from '~/domain/core/order-search'
import type { PoolClient } from 'pg'
import { transition, audit } from '../core/order-lifecycle'
import { physicalStock } from '../availability/availability'
import { currentShift } from './shift'
import { apiError } from '~/kernel/errors'
import { localized, type I18nField } from '~/common/utils/i18n-field'
import { entitlementsFor, hasFeature } from '../core/entitlements'

export interface OrderSearchResult {
  id: string
  publicCode: string
  status: string
  customerName: string | null
  /**
   * ⚠️ `null` у выдачи без брони: там клиента не записывают вовсе.
   * Раньше тип обещал `string`, а `LEFT JOIN customer` отдавал null —
   * и `phone.slice(-4)` ронял ВЕСЬ список стойки в 500.
   */
  phoneTail: string | null
  startsAt: Date
  endsAt: Date
  total: string | null
  lines: number
}

/**
 * Поиск заказа — три равноправных способа.
 *
 * ⚠️ Ни один не обязателен: система работает, когда камера не работает,
 * экран разбит, а клиент помнит только имя. Поиск по последним 4 цифрам
 * телефона — самое быстрое, что человек может назвать.
 */
export async function findOrders(
  c: PoolClient,
  opts: {
    tenantId: string
    /** Номер заказа, телефон (или его хвост), имя. */
    q?: string
    branchId?: string
    /** Заказы на сегодня — открыты по умолчанию, оттуда большинство. */
    today?: boolean
    limit?: number
  },
): Promise<OrderSearchResult[]> {
  const { q, digits } = orderSearchTerm(opts.q)

  const { rows } = await c.query<{
    id: string
    public_code: string
    status: string
    name: string | null
    // ⚠️ LEFT JOIN: у выдачи без брони клиента нет.
    phone: string | null
    starts_at: Date
    ends_at: Date
    total_amount: string | null
    lines: number
  }>(
    `SELECT o.id, o.public_code, o.status, cu.name, cu.phone,
            lower(o.period) AS starts_at, upper(o.period) AS ends_at,
            o.total_amount,
            (SELECT count(*)::int FROM order_line l WHERE l.order_id = o.id) AS lines
     FROM rental_order o
     LEFT JOIN customer cu ON cu.id = o.customer_id
     WHERE o.tenant_id = $1
       AND ($2::uuid IS NULL OR o.branch_pickup_id = $2)
       -- Заказы на сегодня по календарю филиала, а не по UTC.
       AND (NOT $3 OR lower(o.period)::date
                      = (now() AT TIME ZONE (SELECT timezone FROM branch b
                                             WHERE b.id = o.branch_pickup_id))::date)
       AND ${orderSearchSql(4, 5)}
     ORDER BY lower(o.period)
     LIMIT $6`,
    [opts.tenantId, opts.branchId ?? null, opts.today ?? false, q, digits, opts.limit ?? 50],
  )

  return rows.map((r) => ({
    id: r.id,
    publicCode: r.public_code,
    status: r.status,
    customerName: r.name,
    // ⚠️ Наружу только хвост телефона: полный номер на экране стойки
    // виден очереди за спиной, а это персональные данные.
    //
    // ⚠️ Телефона может не быть: выдача без брони оформляется без
    // клиента. Три таких заказа на демо роняли весь список в 500,
    // стоило снять галочку «только на сегодня».
    phoneTail: r.phone ? r.phone.slice(-4) : null,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    total: r.total_amount,
    lines: r.lines,
  }))
}

export interface IssueLine {
  orderLineId: string
  /** Фактически выданное количество. Может отличаться от заказанного. */
  qty: number
  /**
   * Конкретные вещи при поимённом учёте — по одной на единицу.
   *
   * ⚠️ Указывается КАЖДАЯ вещь комплекта, а не одна на строку: если
   * выдать три борда, отметив один номер, два уедут неучтёнными —
   * их не потребуют назад, а склад будет считать их на месте.
   *
   * ⚠️ Способ указания (скан, ввод руками, выбор из списка) домену
   * безразличен: сюда приходят уже id вещей.
   */
  itemIds?: string[]
  /** BSL со штампа на ботинке — читается при выдаче. */
  bslMm?: number
  /** Рекомендованный системой DIN. */
  dinRecommended?: number
  /** ⚠️ Фактически выставленный техником. Именно он пишется в заказ. */
  dinActual?: number
}

/**
 * Отметить выдачу.
 *
 * ⚠️ Возвращает список расхождений, но НЕ отказывает: наличие — оценка,
 * а не истина. Расхождение делается видимым и фиксируется в журнале,
 * работа продолжается.
 */
/**
 * Ведётся ли позиция поимённо И оплачена ли эта функция.
 *
 * ⚠️ Тариф проверяется вместе с режимом: понижение тарифа ничего не
 * удаляет, поэтому категория может остаться в `labeled` у проката,
 * который за поимённый учёт больше не платит. Требовать у него скан
 * значит остановить стойку на функции, которой у него нет.
 */
async function isLabeled(
  c: PoolClient,
  tenantId: string,
  variantId: string,
): Promise<boolean> {
  const { rows } = await c.query<{ tracking: string }>(
    `SELECT cat.tracking FROM inventory_variant v
       JOIN category cat ON cat.id = v.category_id
      WHERE v.id = $1`,
    [variantId],
  )
  if (rows[0]?.tracking !== 'labeled') return false

  const e = await entitlementsFor(c, tenantId)
  return hasFeature(e, 'labeledInventory')
}

/**
 * Можно ли выдать именно эти вещи.
 *
 * ⚠️ Проверяется ДО записи и по трём причинам сразу: вещь чужой
 * позиции (отсканировали не то), вещь списана, вещь уже на руках
 * у другого клиента. Последнее ловит и EXCLUDE в БД, но 23P01 без
 * разбора — это «ошибка сервера» для сотрудника, а ему нужно знать,
 * какую вещь отложить.
 */
async function assertItemsIssuable(
  c: PoolClient,
  opts: { tenantId: string, variantId: string, itemIds: string[] },
): Promise<void> {
  const { rows } = await c.query<{
    id: string, label_code: string, variant_id: string,
    archived: boolean, busy_order: string | null
  }>(
    `SELECT i.id, i.label_code, i.variant_id,
            (i.archived_at IS NOT NULL) AS archived,
            (SELECT o.public_code FROM order_line ol
               JOIN rental_order o ON o.id = ol.order_id
              WHERE ol.item_id = i.id AND ol.status = 'picked_up'
              LIMIT 1) AS busy_order
       FROM item i
      WHERE i.tenant_id = $1 AND i.id = ANY($2::uuid[])`,
    [opts.tenantId, opts.itemIds],
  )

  const found = new Map(rows.map((r) => [r.id, r]))
  for (const id of opts.itemIds) {
    const it = found.get(id)
    if (!it) throw apiError('NOT_FOUND', 'Вещь не найдена')
    if (it.archived) {
      throw apiError('ITEM_ARCHIVED', `${it.label_code} списана со склада`, {
        labelCode: it.label_code,
      })
    }
    if (it.variant_id !== opts.variantId) {
      throw apiError('ITEM_MISMATCH', `${it.label_code} — другая позиция`, {
        labelCode: it.label_code, itemId: it.id,
      })
    }
    if (it.busy_order) {
      throw apiError('ITEM_BUSY', `${it.label_code} уже выдана по заказу ${it.busy_order}`, {
        labelCode: it.label_code, orderCode: it.busy_order,
      })
    }
  }
}

/**
 * Расщепляет строку заказа на `parts` строк по одной вещи.
 *
 * ⚠️ Цена — СНИМОК (железное правило 6), поэтому деньги делятся
 * с точностью до копейки, а остаток от деления кладётся в первую
 * строку. Сумма частей обязана совпасть с исходной: иначе выдача
 * молча меняет заказ в деньгах, а клиенту называли другую сумму.
 *
 * ⚠️ Копейки целыми, без float: 0.1 + 0.2 в double даёт 0.30000000000000004,
 * и на тысяче заказов это расходится с кассой.
 */
async function splitLine(
  c: PoolClient,
  opts: { orderLineId: string, parts: number },
): Promise<string[]> {
  if (opts.parts <= 1) return [opts.orderLineId]

  const { rows } = await c.query<{ amount: string | null }>(
    `SELECT amount::text FROM order_line WHERE id = $1`,
    [opts.orderLineId],
  )
  const totalKop = Math.round(Number(rows[0]?.amount ?? 0) * 100)
  const base = Math.floor(totalKop / opts.parts)
  const rest = totalKop - base * opts.parts

  const ids = [opts.orderLineId]
  await c.query(
    `UPDATE order_line SET qty = 1, amount = $2::numeric WHERE id = $1`,
    [opts.orderLineId, ((base + rest) / 100).toFixed(2)],
  )

  for (let i = 1; i < opts.parts; i++) {
    const { rows: made } = await c.query<{ id: string }>(
      // Копия строки целиком: период, вид, DIN — всё сохраняется,
      // меняются только количество и доля цены.
      `INSERT INTO order_line
         (tenant_id, order_id, kind, variant_id, qty, period, status, amount,
          from_set_id, boot_sole_length_mm, din_recommended, din_actual)
       SELECT tenant_id, order_id, kind, variant_id, 1, period, status,
              $2::numeric, from_set_id, boot_sole_length_mm,
              din_recommended, din_actual
         FROM order_line WHERE id = $1
       RETURNING id`,
      [opts.orderLineId, (base / 100).toFixed(2)],
    )
    ids.push(made[0]!.id)
  }
  return ids
}

export async function issueOrder(
  c: PoolClient,
  opts: {
    tenantId: string
    orderId: string
    staffId: string
    lines: IssueLine[]
    /** Смена: если открытой нет, создаётся неявная. */
    shiftId?: string
    reason?: string
  },
): Promise<{
  mismatches: { variantId: string, expected: number, actual: number }[]
  status: string
  shiftId: string
}> {
  const mismatches: { variantId: string, expected: number, actual: number }[] = []

  // ⚠️ Смена определяется здесь, а не приходит из интерфейса: если её
  // передавать снаружи, стойка будет присылать null, и привязка
  // операций к смене не появится — а задним числом её не восстановить.
  const branch = await branchOfOrder(c, opts.orderId)
  const shift = await currentShift(c, {
    tenantId: opts.tenantId,
    branchId: branch,
    staffId: opts.staffId,
  })
  const shiftId = opts.shiftId ?? shift.id

  for (const line of opts.lines) {
    const { rows } = await c.query<{
      id: string
      variant_id: string | null
      qty: number
      branch_id: string
    }>(
      `SELECT l.id, l.variant_id, l.qty, o.branch_pickup_id AS branch_id
       FROM order_line l
       JOIN rental_order o ON o.id = l.order_id
       WHERE l.id = $1 AND l.order_id = $2`,
      [line.orderLineId, opts.orderId],
    )
    const row = rows[0]
    if (!row) throw apiError('NOT_FOUND', 'Позиция заказа не найдена')
    if (!row.variant_id) continue

    // Проверяем физическое наличие — но только чтобы ЗАФИКСИРОВАТЬ
    // расхождение, а не чтобы запретить выдачу.
    const stock = await physicalStock(c, opts.tenantId, row.variant_id)
    if (stock < line.qty) {
      mismatches.push({
        variantId: row.variant_id,
        expected: stock,
        actual: line.qty,
      })
    }

    // ⚠️ Поимённый учёт: вещи ОБЯЗАТЕЛЬНЫ и проверяются до записи.
    // Выдать «три борда», отметив один номер, значит отправить две
    // вещи в неучтённый оборот: их не потребуют назад, а склад будет
    // считать их на месте.
    const labeled = await isLabeled(c, opts.tenantId, row.variant_id)
    const itemIds = line.itemIds ?? []

    if (labeled) {
      if (itemIds.length !== line.qty) {
        throw apiError(
          'VALIDATION_FAILED',
          `Укажите вещи: нужно ${line.qty}, указано ${itemIds.length}`,
          { orderLineId: line.orderLineId, need: line.qty, got: itemIds.length },
        )
      }
      if (new Set(itemIds).size !== itemIds.length) {
        throw apiError('VALIDATION_FAILED', 'Одна вещь указана дважды')
      }
      await assertItemsIssuable(c, {
        tenantId: opts.tenantId,
        variantId: row.variant_id,
        itemIds,
      })
    }

    // ⚠️ Строка расщепляется: одна вещь — одна строка. Иначе item_id
    // (одно поле) не вместил бы три борда, а EXCLUDE по (item_id,
    // period) не смог бы защитить от двойной выдачи.
    const lineIds = labeled
      ? await splitLine(c, { orderLineId: line.orderLineId, parts: itemIds.length })
      : [line.orderLineId]

    for (const [i, lineId] of lineIds.entries()) {
      await c.query(
        // ⚠️ verified_by заполняется ТОЛЬКО вместе с фактическим DIN:
        // подпись без значения ничего не подтверждает, а значение без
        // подписи не даёт следа ответственности.
        `UPDATE order_line
         SET status = 'picked_up',
             item_id = COALESCE($6::uuid, item_id),
             boot_sole_length_mm = COALESCE($2, boot_sole_length_mm),
             din_recommended = COALESCE($3, din_recommended),
             din_actual = COALESCE($4, din_actual),
             verified_by = CASE WHEN $4 IS NOT NULL THEN $5::uuid ELSE verified_by END,
             verified_at = CASE WHEN $4 IS NOT NULL THEN now() ELSE verified_at END
         WHERE id = $1`,
        [lineId, line.bslMm ?? null,
         line.dinRecommended ?? null, line.dinActual ?? null, opts.staffId,
         labeled ? itemIds[i] : null],
      )
    }

    // Движение: физическое наличие — это СУММА журнала, поэтому
    // ⚠️ qty знаковое: выдача уменьшает склад, значит минус.
    //
    // ⚠️ При поимённом учёте — движение НА КАЖДУЮ вещь: история вещи
    // строится из движений, и одна запись «−3» не сказала бы, какие
    // именно три уехали.
    if (labeled) {
      for (const itemId of itemIds) {
        await c.query(
          `INSERT INTO movement
             (tenant_id, branch_id, variant_id, item_id, kind, qty, order_id,
              staff_id, shift_id, reason)
           VALUES ($1, $2, $3, $4, 'issue', -1, $5, $6, $7, $8)`,
          [opts.tenantId, row.branch_id, row.variant_id, itemId,
           opts.orderId, opts.staffId, opts.shiftId ?? null,
           opts.reason ?? 'выдача'],
        )
      }
    } else {
      await c.query(
        `INSERT INTO movement
           (tenant_id, branch_id, variant_id, kind, qty, order_id,
            staff_id, shift_id, reason)
         VALUES ($1, $2, $3, 'issue', $4, $5, $6, $7, $8)`,
        [opts.tenantId, row.branch_id, row.variant_id, -line.qty,
         opts.orderId, opts.staffId, opts.shiftId ?? null,
         mismatches.length ? 'выдано при расхождении наличия' : null],
      )
    }
  }

  const { order } = await transition(c, {
    orderId: opts.orderId,
    to: 'issued',
    actor: { type: 'staff', staffId: opts.staffId, reason: opts.reason },
    payload: mismatches.length ? { mismatches } : undefined,
  })

  // ⚠️ Выдача при расхождении — ручное вмешательство, и оно попадает
  // в audit_log отдельной записью: через месяц надо понимать, почему
  // журнал разошёлся с фактом.
  if (mismatches.length) {
    await audit(c, {
      tenantId: opts.tenantId,
      staffId: opts.staffId,
      action: 'order.issued_on_mismatch',
      targetType: 'rental_order',
      targetId: opts.orderId,
      reason: opts.reason ?? 'вещь физически в наличии, журнал расходится',
      after: { mismatches },
    })
  }

  // Выдача привязывается к смене и на самом заказе: разбор недостачи
  // идёт по заказам, а не только по движениям.
  await c.query(`UPDATE rental_order SET shift_id = $2 WHERE id = $1`,
    [opts.orderId, shiftId])

  return { mismatches, status: order.status, shiftId }
}

/** Филиал выдачи заказа — нужен для определения смены. */
async function branchOfOrder(c: PoolClient, orderId: string): Promise<string> {
  const { rows } = await c.query<{ branch_pickup_id: string }>(
    `SELECT branch_pickup_id FROM rental_order WHERE id = $1`,
    [orderId],
  )
  const branch = rows[0]?.branch_pickup_id
  if (!branch) throw apiError('NOT_FOUND', 'Заказ не найден')
  return branch
}

export interface ItemLookup {
  itemId: string
  labelCode: string
  categoryName: string
  variantName: string
  /** Заказ, по которому вещь сейчас на руках. */
  orderId: string | null
  orderCode: string | null
  orderLineId: string | null
  /** Статус заказа: по нему видно, ждут ли эту вещь обратно. */
  orderStatus: string | null
  state: 'issued' | 'free' | 'service'
}

/**
 * Найти вещь по номеру и понять, чья она.
 *
 * ⚠️ Это и есть приёмка по скану: вещь САМА говорит, в каком она
 * заказе, и заказ не надо искать по телефону. Если вещь числится за
 * другим открытым заказом — это не ошибка, а ситуация: клиенты могли
 * обменяться на склоне. Решение принимает человек, система лишь
 * обязана показать, что именно происходит.
 */
export async function lookupItemForReturn(
  c: PoolClient,
  opts: { tenantId: string, code: string, locale?: string },
): Promise<ItemLookup | null> {
  const { rows } = await c.query<{
    item_id: string, label_code: string,
    category_name: I18nField, category_code: string,
    variant_name: I18nField, variant_code: string,
    order_id: string | null, order_code: string | null,
    order_line_id: string | null, order_status: string | null,
    in_service: string,
  }>(
    `SELECT i.id AS item_id, i.label_code,
            cat.name AS category_name, cat.code AS category_code,
            v.name AS variant_name, v.code AS variant_code,
            o.id AS order_id, o.public_code AS order_code,
            ol.id AS order_line_id, o.status::text AS order_status,
            COALESCE((SELECT -SUM(m.qty) FROM movement m
                       WHERE m.item_id = i.id
                         AND m.kind IN ('to_service', 'from_service')), 0)::text AS in_service
       FROM item i
       JOIN inventory_variant v ON v.id = i.variant_id
       JOIN category cat ON cat.id = v.category_id
       LEFT JOIN order_line ol ON ol.item_id = i.id AND ol.status = 'picked_up'
       LEFT JOIN rental_order o ON o.id = ol.order_id
      WHERE i.tenant_id = $1 AND upper(i.label_code) = upper($2)
        AND i.archived_at IS NULL
      LIMIT 1`,
    [opts.tenantId, opts.code.trim()],
  )

  const r = rows[0]
  if (!r) return null

  const locale = opts.locale ?? 'ru'
  return {
    itemId: r.item_id,
    labelCode: r.label_code,
    categoryName: localized(r.category_name, locale, r.category_code),
    variantName: localized(r.variant_name, locale, r.variant_code),
    orderId: r.order_id,
    orderCode: r.order_code,
    orderLineId: r.order_line_id,
    orderStatus: r.order_status,
    state: r.order_id ? 'issued' : (Number(r.in_service) > 0 ? 'service' : 'free'),
  }
}

export interface ReturnLine {
  orderLineId: string
  qty: number
  /** Состояние: ok, damaged, lost. Влияет на дальнейшую судьбу вещи. */
  condition?: 'ok' | 'damaged' | 'lost'
  /** Нужно ли обслуживание и какое. */
  serviceKind?: 'drying' | 'sharpening' | 'wax' | 'repair' | 'inspection' | 'other'
}

/**
 * Отметить возврат.
 *
 * ⚠️ Возврат может быть частичным: вернули борд, ботинки оставили.
 * Тогда заказ переходит в partially_returned, а не в returned, и
 * инвентарь освобождается только по вернувшимся позициям.
 *
 * ⚠️ Перерасчёт при досрочном возврате обязателен по ГК ст. 630 —
 * считается модулем recalc по СНИМКУ правил заказа.
 */
export async function returnOrder(
  c: PoolClient,
  opts: {
    tenantId: string
    orderId: string
    staffId: string
    lines: ReturnLine[]
    shiftId?: string
  },
): Promise<{ status: string, allReturned: boolean, shiftId: string }> {
  const branch = await branchOfOrder(c, opts.orderId)
  const shift = await currentShift(c, {
    tenantId: opts.tenantId,
    branchId: branch,
    staffId: opts.staffId,
  })
  const shiftId = opts.shiftId ?? shift.id

  for (const line of opts.lines) {
    const { rows } = await c.query<{
      variant_id: string | null
      item_id: string | null
      branch_id: string
    }>(
      `SELECT l.variant_id, l.item_id, o.branch_pickup_id AS branch_id
       FROM order_line l
       JOIN rental_order o ON o.id = l.order_id
       WHERE l.id = $1 AND l.order_id = $2`,
      [line.orderLineId, opts.orderId],
    )
    const row = rows[0]
    if (!row?.variant_id) continue

    const lost = line.condition === 'lost'

    await c.query(
      `UPDATE order_line
       SET status = $2, returned_at = now(), condition_note = $3
       WHERE id = $1`,
      [line.orderLineId, lost ? 'lost' : 'returned', line.condition ?? 'ok'],
    )

    // Потерянная вещь не возвращается на склад: движение 'return'
    // для неё было бы ложью, физического наличия не прибавилось.
    if (!lost) {
      // Возврат прибавляет к складу: qty положительное.
      await c.query(
        `INSERT INTO movement
           (tenant_id, branch_id, variant_id, item_id, kind, qty, order_id,
            staff_id, shift_id, service_kind, reason)
         VALUES ($1, $2, $3, $4, 'return', $5, $6, $7, $8, $9, $10)`,
        // ⚠️ item_id и здесь: без него история вещи обрывается на
        // выдаче — видно, что уехала, и не видно, что вернулась.
        [opts.tenantId, row.branch_id, row.variant_id, row.item_id ?? null,
         line.qty, opts.orderId, opts.staffId, shiftId,
         line.serviceKind ?? null,
         line.condition === 'damaged' ? 'возврат с повреждением' : null],
      )

      // Повреждённая вещь уходит в обслуживание, а не в продажу:
      // иначе её выдадут следующему клиенту.
      if (line.condition === 'damaged' || line.serviceKind) {
        // В обслуживание — минус со доступного склада: вещь есть,
        // но выдать её нельзя, пока не просохнет и не проверена.
        //
        // ⚠️ item_id переносится из строки заказа: при поимённом учёте
        // техник должен увидеть, КАКАЯ вещь сломана, а не «один борд
        // из шести». Без этого он берёт со стеллажа наугад, и вещь
        // с реальной поломкой возвращается в оборот непочиненной.
        await c.query(
          `INSERT INTO movement
             (tenant_id, branch_id, variant_id, item_id, kind, qty, staff_id,
              shift_id, service_kind, reason)
           VALUES ($1, $2, $3, $4, 'to_service', $5, $6, $7, $8, $9)`,
          [opts.tenantId, row.branch_id, row.variant_id, row.item_id ?? null,
           -line.qty, opts.staffId, shiftId,
           line.serviceKind ?? 'inspection',
           'после возврата'],
        )
      }
    } else {
      // Потеря — списание: минус, и вещь на склад не вернулась.
      await c.query(
        `INSERT INTO movement
           (tenant_id, branch_id, variant_id, kind, qty, order_id,
            staff_id, shift_id, reason)
         VALUES ($1, $2, $3, 'write_off', $4, $5, $6, $7, 'не возвращено клиентом')`,
        [opts.tenantId, row.branch_id, row.variant_id, -line.qty,
         opts.orderId, opts.staffId, shiftId],
      )
    }
  }

  // Всё ли вернулось: от этого зависит статус заказа.
  //
  // ⚠️ Заказ НЕ закрывается, пока хоть одна выданная вещь не вернулась.
  // При поимённом учёте это буквально: каждая вещь — своя строка, и
  // строка не станет `returned` без отметки возврата. Закрыть заказ
  // с невозвращённой вещью значит перестать её ждать — и потерять.
  const { rows: pending } = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM order_line
     WHERE order_id = $1 AND status NOT IN ('returned', 'cancelled', 'lost')`,
    [opts.orderId],
  )
  const allReturned = (pending[0]?.n ?? 0) === 0

  const { order } = await transition(c, {
    orderId: opts.orderId,
    to: allReturned ? 'returned' : 'partially_returned',
    actor: { type: 'staff', staffId: opts.staffId },
  })

  return { status: order.status, allReturned, shiftId }
}

/**
 * Заказ «с улицы» — человек пришёл без брони.
 *
 * ⚠️ Кнопка ПЕРВОГО уровня, а не спрятанная функция. Если это неудобно,
 * сотрудник обойдёт систему, и она станет бесполезной в первый же
 * выходной. Заказ создаётся задним числом с теми параметрами, которые
 * успели спросить — «не учитывается» не вариант.
 */
export async function walkInOrder(
  c: PoolClient,
  opts: {
    tenantId: string
    branchId: string
    staffId: string
    from: Date
    to: Date
    name?: string
    phone?: string
    lines: { variantId: string, qty: number, amount?: string }[]
    total?: string
    shiftId?: string
  },
): Promise<{ orderId: string, publicCode: string, shiftId: string }> {
  const shift = await currentShift(c, {
    tenantId: opts.tenantId,
    branchId: opts.branchId,
    staffId: opts.staffId,
  })
  const shiftId = opts.shiftId ?? shift.id

  let customerId: string | null = null

  // Телефон может быть неизвестен: человек стоит у стойки, и
  // требовать контакт ради учёта — тот же барьер, что и запрет выдачи.
  if (opts.phone) {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO customer (tenant_id, phone, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, phone) DO UPDATE
         SET name = COALESCE(excluded.name, customer.name)
       RETURNING id`,
      [opts.tenantId, opts.phone, opts.name ?? null],
    )
    customerId = rows[0]!.id
  }

  const code = walkInCode()

  const { rows: [order] } = await c.query<{ id: string }>(
    `INSERT INTO rental_order
       (tenant_id, public_code, branch_pickup_id, customer_id, status, period,
        total_amount, shift_id, retention_until)
     VALUES ($1, $2, $3, $4, 'issued', tstzrange($5, $6), $7, $8,
             now() + interval '3 years')
     RETURNING id`,
    [opts.tenantId, code, opts.branchId, customerId, opts.from, opts.to,
     opts.total ?? null, shiftId],
  )
  const orderId = order!.id

  for (const l of opts.lines) {
    const { rows: [lineRow] } = await c.query<{ id: string }>(
      `INSERT INTO order_line
         (tenant_id, order_id, kind, variant_id, qty, period, amount, status)
       VALUES ($1, $2, 'rental', $3, $4, tstzrange($5, $6), $7, 'picked_up')
       RETURNING id`,
      [opts.tenantId, orderId, l.variantId, l.qty, opts.from, opts.to, l.amount ?? null],
    )

    await c.query(
      `INSERT INTO movement
         (tenant_id, branch_id, variant_id, kind, qty, order_id,
          staff_id, shift_id, reason)
       VALUES ($1, $2, $3, 'issue', $4, $5, $6, $7, 'выдача без брони')`,
      [opts.tenantId, opts.branchId, l.variantId, -l.qty,
       orderId, opts.staffId, shiftId],
    )
    void lineRow
  }

  // Событие: заказ создан сотрудником, а не клиентом.
  await c.query(
    `INSERT INTO event
       (tenant_id, aggregate_type, aggregate_id, kind, payload, actor_type, actor_id)
     VALUES ($1, 'rental_order', $2, 'order.walk_in', $3, 'staff', $4)`,
    [opts.tenantId, orderId,
     JSON.stringify({ code, lines: opts.lines.length }), opts.staffId],
  )

  return { orderId, publicCode: code, shiftId }
}

/**
 * Код заказа «с улицы».
 *
 * Отличается префиксом от онлайн-заказов: на стойке видно, что заказ
 * создан вручную, без сверки с бронью.
 */
function walkInCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let out = 'W'
  for (let i = 0; i < 5; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return out
}
