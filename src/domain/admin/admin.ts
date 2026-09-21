/**
 * Данные админки тенанта.
 *
 * ⚠️ Главный экран — «Сегодня» (../rental-docs/docs/04-тз/20-фронтенд/26-админка.md): не
 * дашборд с графиками, а список того, что требует действия сегодня.
 * Графики можно посмотреть когда угодно, а просроченный возврат и
 * упавшая отправка требуют вмешательства сейчас.
 *
 * ⚠️ Пагинация курсорная, а не по OFFSET: при листании заказов с
 * OFFSET страницы «съезжают» по мере появления новых записей, и
 * оператор видит одну и ту же бронь дважды либо пропускает её.
 */
import { orderSearchTerm, orderSearchSql } from '~/domain/core/order-search'
import type { PoolClient } from 'pg'
import { apiError } from '~/kernel/errors'
import { localized, type I18nField } from '~/common/utils/i18n-field'
import { createItems } from '~/domain/inventory/items'
import { getLimits } from '~/domain/pricing/limits'

export interface TodayScreen {
  /** Выдачи, которые должны состояться сегодня. */
  pickupsToday: number
  /** Возвраты, ожидаемые сегодня. */
  returnsToday: number
  /** Просрочено: вещь физически отсутствует. */
  overdue: number
  /** Брони, у которых дедлайн подтверждения истекает в ближайшие сутки. */
  deadlineSoon: number
  /** Ждут решения оператора: крупные заказы без удержания инвентаря. */
  awaitingStock: number
  waitlistWaiting: number
  /** ⚠️ Упавшие отправки: без них клиент не узнал о заказе. */
  outboxDead: number
  outboxPending: number
}

/**
 * Экран «Сегодня».
 *
 * ⚠️ «Сегодня» считается по календарю ФИЛИАЛА: администратор сети из
 * Москвы, смотрящий на красноярский филиал, должен видеть его день,
 * а не свой.
 */
export async function todayScreen(
  c: PoolClient,
  opts: { tenantId: string, branchIds?: string[] },
): Promise<TodayScreen> {
  const scoped = (opts.branchIds?.length ?? 0) > 0
  const branchIds = opts.branchIds ?? []

  const { rows } = await c.query<{
    pickups_today: number
    returns_today: number
    overdue: number
    deadline_soon: number
    awaiting_stock: number
  }>(
    `SELECT
       count(*) FILTER (
         WHERE (lower(o.period) AT TIME ZONE b.timezone)::date
               = (now() AT TIME ZONE b.timezone)::date
           AND o.status IN ('confirmed', 'awaiting_confirm')
       )::int AS pickups_today,
       count(*) FILTER (
         WHERE (upper(o.period) AT TIME ZONE b.timezone)::date
               = (now() AT TIME ZONE b.timezone)::date
           AND o.status IN ('issued', 'partially_returned')
       )::int AS returns_today,
       count(*) FILTER (WHERE o.status = 'overdue')::int AS overdue,
       count(*) FILTER (
         WHERE o.status = 'awaiting_confirm'
           AND o.confirm_deadline IS NOT NULL
           AND o.confirm_deadline BETWEEN now() AND now() + interval '24 hours'
       )::int AS deadline_soon,
       count(*) FILTER (WHERE o.status = 'awaiting_stock')::int AS awaiting_stock
     FROM rental_order o
     JOIN branch b ON b.id = o.branch_pickup_id
     WHERE o.tenant_id = $1
       AND (NOT $2 OR o.branch_pickup_id = ANY($3::uuid[]))`,
    [opts.tenantId, scoped, branchIds],
  )

  const { rows: wl } = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM waitlist
     WHERE tenant_id = $1 AND status = 'waiting' AND expires_at > now()
       AND (NOT $2 OR branch_id = ANY($3::uuid[]))`,
    [opts.tenantId, scoped, branchIds],
  )

  // Упавшие отправки — отдельно и обязательно: на подтверждении
  // держится защита инвентаря, и молчащая очередь её ломает.
  const { rows: ob } = await c.query<{ dead: number, pending: number }>(
    `SELECT
       count(*) FILTER (WHERE status = 'dead')::int AS dead,
       count(*) FILTER (WHERE status = 'pending')::int AS pending
     FROM outbox WHERE tenant_id = $1`,
    [opts.tenantId],
  )

  const r = rows[0]
  return {
    pickupsToday: r?.pickups_today ?? 0,
    returnsToday: r?.returns_today ?? 0,
    overdue: r?.overdue ?? 0,
    deadlineSoon: r?.deadline_soon ?? 0,
    awaitingStock: r?.awaiting_stock ?? 0,
    waitlistWaiting: wl[0]?.n ?? 0,
    outboxDead: ob[0]?.dead ?? 0,
    outboxPending: ob[0]?.pending ?? 0,
  }
}

export interface OrderListItem {
  id: string
  publicCode: string
  status: string
  customerName: string | null
  phone: string | null
  startsAt: Date
  endsAt: Date
  total: string | null
  branchName: string
}

/**
 * Список заказов с курсорной пагинацией.
 *
 * ⚠️ Курсор — это пара (created_at, id), а не только время: заказы,
 * созданные в одну миллисекунду, при курсоре по времени либо
 * дублировались бы, либо пропадали.
 */
export async function listOrders(
  c: PoolClient,
  opts: {
    tenantId: string
    branchIds?: string[]
    status?: string[]
    q?: string
    /** Курсор предыдущей страницы в формате «isoDate|uuid». */
    cursor?: string
    limit?: number
    /** Начало периода аренды не раньше этого дня, «YYYY-MM-DD». */
    from?: string
    /** Начало периода аренды не позже этого дня, «YYYY-MM-DD». */
    to?: string
  },
): Promise<{ items: OrderListItem[], nextCursor: string | null }> {
  const scoped = (opts.branchIds?.length ?? 0) > 0
  const limit = Math.min(opts.limit ?? 50, 200)

  let cursorAt: Date | null = null
  let cursorId: string | null = null
  if (opts.cursor) {
    const [at, id] = opts.cursor.split('|')
    if (at && id) {
      cursorAt = new Date(at)
      cursorId = id
    }
  }

  const { q, digits } = orderSearchTerm(opts.q)

  const { rows } = await c.query<{
    id: string
    public_code: string
    status: string
    name: string | null
    phone: string | null
    starts_at: Date
    ends_at: Date
    total_amount: string | null
    branch_name: string
    created_at: Date
  }>(
    `SELECT o.id, o.public_code, o.status, cu.name, cu.phone,
            lower(o.period) AS starts_at, upper(o.period) AS ends_at,
            o.total_amount, b.name AS branch_name, o.created_at
     FROM rental_order o
     JOIN branch b ON b.id = o.branch_pickup_id
     LEFT JOIN customer cu ON cu.id = o.customer_id
     WHERE o.tenant_id = $1
       AND (NOT $2 OR o.branch_pickup_id = ANY($3::uuid[]))
       AND ($4::text[] IS NULL OR o.status::text = ANY($4))
       AND ${orderSearchSql(5, 6)}
       -- ⚠️ Фильтр по ДНЮ НАЧАЛА аренды в поясе филиала, а не по UTC:
       -- «заказы на 10 сентября» для филиала в Красноярске — это его
       -- сутки, и в UTC они начинаются накануне.
       AND ($10::date IS NULL
            OR (lower(o.period) AT TIME ZONE b.timezone)::date >= $10::date)
       AND ($11::date IS NULL
            OR (lower(o.period) AT TIME ZONE b.timezone)::date <= $11::date)
       -- Курсор: строго «раньше» по паре (created_at, id).
       AND ($7::timestamptz IS NULL
            OR (o.created_at, o.id) < ($7::timestamptz, $8::uuid))
     ORDER BY o.created_at DESC, o.id DESC
     LIMIT $9`,
    [
      opts.tenantId, scoped, opts.branchIds ?? [],
      opts.status?.length ? opts.status : null,
      q, digits, cursorAt, cursorId, limit + 1,
      opts.from || null, opts.to || null,
    ],
  )

  // Лишняя запись показывает, что есть следующая страница.
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const last = page[page.length - 1]

  return {
    items: page.map((r) => ({
      id: r.id,
      publicCode: r.public_code,
      status: r.status,
      customerName: r.name,
      phone: r.phone,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      total: r.total_amount,
      branchName: r.branch_name,
    })),
    nextCursor: hasMore && last
      ? `${last.created_at.toISOString()}|${last.id}`
      : null,
  }
}

export interface OrderTimelineEntry {
  kind: string
  occurredAt: Date
  actorType: string | null
  actorName: string | null
  payload: Record<string, unknown>
  /** Причина — только у ручных вмешательств. */
  reason: string | null
}

/**
 * Хронология заказа.
 *
 * ⚠️ Собирается из event И audit_log вместе: события говорят «что
 * произошло», audit_log — «почему человек это сделал». По отдельности
 * ни то, ни другое не отвечает на вопрос «почему у этого заказа
 * нестандартные условия», ради которого хронология и нужна.
 */
export async function orderTimeline(
  c: PoolClient,
  opts: { tenantId: string, orderId: string },
): Promise<OrderTimelineEntry[]> {
  const { rows } = await c.query<{
    kind: string
    occurred_at: Date
    actor_type: string | null
    actor_name: string | null
    payload: Record<string, unknown>
    reason: string | null
  }>(
    `SELECT e.kind, e.occurred_at, e.actor_type, st.name AS actor_name,
            e.payload, NULL::text AS reason
     FROM event e
     LEFT JOIN staff st ON st.id = e.actor_id
     WHERE e.tenant_id = $1 AND e.aggregate_id = $2

     UNION ALL

     SELECT a.action AS kind, a.occurred_at, 'staff' AS actor_type,
            st.name AS actor_name,
            jsonb_build_object('before', a.before, 'after', a.after) AS payload,
            a.reason
     FROM audit_log a
     LEFT JOIN staff st ON st.id = a.staff_id
     WHERE a.tenant_id = $1 AND a.target_id = $2

     ORDER BY occurred_at`,
    [opts.tenantId, opts.orderId],
  )

  return rows.map((r) => ({
    kind: r.kind,
    occurredAt: r.occurred_at,
    actorType: r.actor_type,
    actorName: r.actor_name,
    payload: r.payload ?? {},
    reason: r.reason,
  }))
}

/**
 * Правка количества инвентаря в один шаг.
 *
 * ⚠️ Именно в один шаг и прямо из списка (13.5.1): если для «привезли
 * ещё два борда» нужно открывать карточку и заполнять форму, склад
 * не будет обновляться, и наличие разойдётся с реальностью.
 *
 * ⚠️ При УМЕНЬШЕНИИ причина обязательна: увеличение объяснимо само
 * (поступление), а уменьшение без причины через месяц неотличимо
 * от кражи.
 *
 * ⚠️ При поимённом учёте (`tracking = labeled`) поступление ЗАВОДИТ
 * ЕДИНИЦЫ, а не только пишет движение. Иначе «привезли ещё одни
 * ботинки» даёт остаток 7 при шести номерах: седьмую вещь нечем
 * пометить и невозможно выдать по скану, а расхождение выглядит как
 * ошибка учёта. Списание единицы НЕ трогает: какую именно вещь
 * убрали — решает человек на экране единиц, а не порядок в списке.
 */
export async function adjustQuantity(
  c: PoolClient,
  opts: {
    tenantId: string
    branchId: string
    variantId: string
    delta: number
    staffId: string
    reason?: string
    shiftId?: string
  },
): Promise<{ newTotal: number }> {
  if (opts.delta === 0) {
    const { rows } = await c.query<{ total: string }>(
      `SELECT COALESCE(SUM(qty), 0)::text AS total FROM movement
       WHERE tenant_id = $1 AND variant_id = $2 AND branch_id = $3`,
      [opts.tenantId, opts.variantId, opts.branchId],
    )
    return { newTotal: Number(rows[0]?.total ?? 0) }
  }

  // ⚠️ Требование, а не пожелание: без причины уменьшение количества
  // через месяц неотличимо от кражи или ошибки ввода, и разобрать
  // расхождение будет нечем.
  if (opts.delta < 0 && !opts.reason?.trim()) {
    throw apiError('VALIDATION_FAILED', 'При уменьшении количества нужна причина')
  }

  const kind = opts.delta > 0 ? 'receipt' : 'write_off'

  await c.query(
    `INSERT INTO movement
       (tenant_id, branch_id, variant_id, kind, qty, staff_id, shift_id, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [opts.tenantId, opts.branchId, opts.variantId, kind, opts.delta,
     opts.staffId, opts.shiftId ?? null,
     opts.reason ?? (opts.delta > 0 ? 'поступление' : null)],
  )

  // Ёмкость пула следует за количеством: иначе новые вещи нельзя
  // забронировать, а списанные система продолжит продавать.
  //
  // ⚠️ Календарь НЕ заполняется на горизонт вперёд (19.43). Строка
  // `pool_day` заводится в момент брони; отсутствие строки значит
  // «в этот день никто ничего не бронировал», то есть свободен весь
  // склад. Раньше заполнялось 90–120 дней вперёд, и 95% строк хранили
  // «забронировано 0» — заполнялось то, что почти никогда не нужно.
  //
  // ⚠️ Но ёмкость где-то хранить надо: её берёт и расчёт наличия, и
  // создание строки при брони — из ПОСЛЕДНЕГО известного дня. Поэтому
  // приход делает две вещи:
  //   1) правит уже существующие дни (там могут быть брони);
  //   2) держит один день-ЯКОРЬ в будущем с актуальной ёмкостью.
  //
  // ⚠️ Якорь ставится дальше горизонта бронирования (`maxAdvanceDays`):
  // он должен оставаться «последним днём» при сортировке, иначе
  // обычная бронь на дальнюю дату перебьёт его и ёмкость поедет.
  const { maxAdvanceDays } = await getLimits(c, opts.tenantId)
  const anchorDay = maxAdvanceDays + 365

  // ⚠️ Якорь исключён: его правит следующий запрос. Без этого условия
  // дельта применялась бы к нему ДВАЖДЫ — тест 19.34 «второй приход
  // прибавляется к первому» это и поймал (11 вместо 8).
  await c.query(
    `UPDATE pool_day
        SET capacity = GREATEST(0, capacity + $3)
      WHERE tenant_id = $1 AND variant_id = $2
        AND day >= current_date
        AND day <> (current_date + $4::int)::date`,
    [opts.tenantId, opts.variantId, opts.delta, anchorDay],
  )

  await c.query(
    `INSERT INTO pool_day (tenant_id, variant_id, day, qty_booked, capacity)
     VALUES ($1, $2, (current_date + $4::int)::date, 0, GREATEST(0, $3))
     ON CONFLICT (variant_id, day)
     DO UPDATE SET capacity = GREATEST(0, pool_day.capacity + $3)`,
    [opts.tenantId, opts.variantId, opts.delta, anchorDay],
  )

  // ⚠️ Поступление при поимённом учёте обязано выдать номера: остаток
  // и число единиц — одна и та же величина, посчитанная двумя
  // способами, и разойтись они не должны.
  if (opts.delta > 0) {
    const { rows: t } = await c.query<{ tracking: string }>(
      `SELECT cat.tracking
         FROM inventory_variant v
         JOIN category cat ON cat.id = v.category_id
        WHERE v.id = $1 AND v.tenant_id = $2`,
      [opts.variantId, opts.tenantId],
    )
    if (t[0]?.tracking === 'labeled') {
      await createItems(c, {
        tenantId: opts.tenantId,
        variantId: opts.variantId,
        count: opts.delta,
        staffId: opts.staffId,
      })
    }
  }

  const { rows } = await c.query<{ total: string }>(
    `SELECT COALESCE(SUM(qty), 0)::text AS total FROM movement
     WHERE tenant_id = $1 AND variant_id = $2 AND branch_id = $3`,
    [opts.tenantId, opts.variantId, opts.branchId],
  )

  return { newTotal: Number(rows[0]?.total ?? 0) }
}

export interface OrderDetail {
  id: string
  publicCode: string
  status: string
  branchName: string
  /** Адрес филиала и имя тенанта — стороны и место акта (18.8). */
  branchAddress: string | null
  tenantName: string
  branchId: string
  timezone: string
  startsAt: Date
  endsAt: Date
  total: string | null
  priceBreakdown: unknown
  confirmDeadline: Date | null
  createdAt: Date
  customer: {
    id: string | null
    name: string | null
    phone: string | null
    email: string | null
    noShowCount: number
    bodyParams: Record<string, unknown> | null
  }
  lines: {
    id: string
    kind: string
    variantCode: string | null
    variantName: string | null
    /** Название категории: на бумаге «42» без «Ботинки» не читается. */
    categoryName: string | null
    qty: number
    amount: string | null
    lineStatus: string
    /** Фактический DIN и кто проверил — след ответственности. */
    dinRecommended: string | null
    dinActual: string | null
    verifiedBy: string | null
    verifiedAt: Date | null
    bootSoleLengthMm: number | null
    returnedAt: Date | null
    conditionNote: string | null
  }[]
  agreement: { signedAt: Date, offerVersion: string, channel: string | null } | null
}

/**
 * Карточка заказа (13.3).
 *
 * ⚠️ Строки заказа отдаются вместе с фактическим DIN и подписью
 * техника: это след ответственности за настройку креплений (железное
 * правило №7), и в карточке он должен быть виден без второго запроса —
 * иначе при разборе происшествия его никто не откроет.
 */
export async function orderDetail(
  c: PoolClient,
  opts: { tenantId: string, orderId: string },
): Promise<OrderDetail | null> {
  const { rows } = await c.query<Record<string, never>>(
    // ⚠️ Имя тенанта и адрес филиала нужны акту приёма-передачи (18.8):
    // это стороны и место документа, без них печатать нечего.
    `SELECT o.id, o.public_code, o.status,
            b.name AS branch_name, b.id AS branch_id, b.timezone,
            b.address AS branch_address, t.name AS tenant_name,
            lower(o.period) AS starts_at, upper(o.period) AS ends_at,
            o.total_amount, o.price_breakdown, o.confirm_deadline, o.created_at,
            cu.id AS customer_id, cu.name AS customer_name, cu.phone,
            cu.email, cu.no_show_count, cu.body_params
     FROM rental_order o
     JOIN branch b ON b.id = o.branch_pickup_id
     JOIN tenant t ON t.id = o.tenant_id
     LEFT JOIN customer cu ON cu.id = o.customer_id
     WHERE o.id = $1 AND o.tenant_id = $2`,
    [opts.orderId, opts.tenantId],
  )
  const r = rows[0] as Record<string, unknown> | undefined
  if (!r) return null

  const { rows: lines } = await c.query<Record<string, unknown>>(
    // ⚠️ Название категории — для акта (18.8): на бумаге «42 (mondo 27.0)»
    // без «Ботинки» не читается, а акт подписывают люди.
    // ⚠️ item_id и номер — не украшение: при разборе «нам выдали
    // сломанное» карточка заказа должна отвечать, КАКУЮ вещь выдали,
    // иначе спор упирается в «сноуборд 157» и заканчивается ничем.
    `SELECT ol.id, ol.kind, ol.variant_id, iv.code AS variant_code, iv.name AS variant_name,
            cat.name AS category_name,
            ol.qty, ol.amount, ol.status AS line_status,
            ol.item_id, it.label_code,
            ol.din_recommended, ol.din_actual, ol.verified_at,
            ol.boot_sole_length_mm, ol.returned_at, ol.condition_note,
            st.name AS verified_by
     FROM order_line ol
     LEFT JOIN inventory_variant iv ON iv.id = ol.variant_id
     LEFT JOIN category cat ON cat.id = iv.category_id
     LEFT JOIN item it ON it.id = ol.item_id
     LEFT JOIN staff st ON st.id = ol.verified_by
     WHERE ol.order_id = $1
     ORDER BY ol.kind, iv.code, it.label_code`,
    [opts.orderId],
  )

  const { rows: agr } = await c.query<Record<string, unknown>>(
    `SELECT signed_at, offer_version, sign_channel
     FROM agreement WHERE order_id = $1 ORDER BY signed_at DESC LIMIT 1`,
    [opts.orderId],
  )

  return {
    id: r.id as string,
    publicCode: r.public_code as string,
    status: r.status as string,
    branchName: r.branch_name as string,
    branchAddress: (r.branch_address as string) ?? null,
    tenantName: r.tenant_name as string,
    branchId: r.branch_id as string,
    timezone: r.timezone as string,
    startsAt: r.starts_at as Date,
    endsAt: r.ends_at as Date,
    total: (r.total_amount as string) ?? null,
    priceBreakdown: r.price_breakdown ?? null,
    confirmDeadline: (r.confirm_deadline as Date) ?? null,
    createdAt: r.created_at as Date,
    customer: {
      id: (r.customer_id as string) ?? null,
      name: (r.customer_name as string) ?? null,
      phone: (r.phone as string) ?? null,
      email: (r.email as string) ?? null,
      noShowCount: (r.no_show_count as number) ?? 0,
      bodyParams: (r.body_params as Record<string, unknown>) ?? null,
    },
    lines: lines.map((l) => ({
      id: l.id as string,
      kind: l.kind as string,
      variantId: (l.variant_id as string) ?? null,
      variantCode: (l.variant_code as string) ?? null,
      // ⚠️ Название — jsonb по локалям (8.7), а не строка: в другой
      // стране прокат заведёт свои названия, и это данные тенанта.
      variantName: l.variant_name ? localized(l.variant_name as I18nField, 'ru') : null,
      categoryName: l.category_name ? localized(l.category_name as I18nField, 'ru') : null,
      qty: (l.qty as number) ?? 1,
      amount: (l.amount as string) ?? null,
      lineStatus: (l.line_status as string) ?? '',
      /** Конкретная вещь — заполнена только при поимённом учёте. */
      itemId: (l.item_id as string) ?? null,
      labelCode: (l.label_code as string) ?? null,
      dinRecommended: (l.din_recommended as string) ?? null,
      dinActual: (l.din_actual as string) ?? null,
      verifiedBy: (l.verified_by as string) ?? null,
      verifiedAt: (l.verified_at as Date) ?? null,
      bootSoleLengthMm: (l.boot_sole_length_mm as number) ?? null,
      returnedAt: (l.returned_at as Date) ?? null,
      conditionNote: (l.condition_note as string) ?? null,
    })),
    agreement: agr[0]
      ? {
          signedAt: agr[0].signed_at as Date,
          offerVersion: agr[0].offer_version as string,
          channel: (agr[0].sign_channel as string) ?? null,
        }
      : null,
  }
}

export interface InventoryRow {
  variantId: string
  code: string
  name: string
  categoryCode: string
  categoryName: string
  branchId: string
  branchName: string
  inventoryMode: string
  /** Сколько всего по журналу движений — это и есть «сколько есть». */
  total: number
  /** Сколько занято бронями вперёд — предупреждение при списании. */
  bookedAhead: number
  /** Ближайшая бронь: с ней сотрудник соотносит своё решение. */
  nearestBookingAt: Date | null
}

/**
 * Список инвентаря с остатками (13.4).
 *
 * ⚠️ Остаток считается по ЖУРНАЛУ ДВИЖЕНИЙ, а не хранится полем.
 * Поле «сколько есть» рассинхронизируется с движениями при первой же
 * ошибке, и восстановить правду будет нечем; сумма движений — это
 * и есть правда по построению.
 *
 * ⚠️ Вместе с остатком отдаются БУДУЩИЕ БРОНИ. Без них списание
 * выглядит безобидным: сотрудник убирает две пары ботинок, а на них
 * стоят брони на следующую неделю, и обнаружится это, когда клиент
 * приедет. Предупредить дешевле, чем объясняться.
 */
export async function inventoryList(
  c: PoolClient,
  opts: { tenantId: string, branchIds?: string[], q?: string, locale?: string },
): Promise<InventoryRow[]> {
  const scoped = (opts.branchIds?.length ?? 0) > 0
  const q = opts.q?.trim() ?? ''

  const { rows } = await c.query<Record<string, unknown>>(
    `SELECT iv.id AS variant_id, iv.code, iv.name, iv.inventory_mode,
            iv.branch_id, b.name AS branch_name,
            cat.code AS category_code, cat.name AS category_name,
            COALESCE((
              SELECT SUM(m.qty) FROM movement m
              WHERE m.variant_id = iv.id AND m.branch_id = iv.branch_id
            ), 0)::int AS total,
            COALESCE((
              SELECT SUM(ol.qty) FROM order_line ol
              JOIN rental_order o ON o.id = ol.order_id
              WHERE ol.variant_id = iv.id
                AND o.status IN ('awaiting_confirm', 'confirmed', 'issued',
                                 'partially_returned', 'overdue')
                AND upper(o.period) > now()
            ), 0)::int AS booked_ahead,
            (
              SELECT MIN(lower(o.period)) FROM order_line ol
              JOIN rental_order o ON o.id = ol.order_id
              WHERE ol.variant_id = iv.id
                AND o.status IN ('awaiting_confirm', 'confirmed')
                AND lower(o.period) > now()
            ) AS nearest_booking_at
     FROM inventory_variant iv
     JOIN branch b ON b.id = iv.branch_id
     JOIN category cat ON cat.id = iv.category_id
     WHERE iv.tenant_id = $1
       AND iv.archived_at IS NULL
       -- ⚠️ Услуги исключены: у заточки нет остатка на складе, и «0 шт»
       -- рядом с ней выглядит нехваткой. Услуги живут в прайсе (13.9).
       AND cat.code <> 'service'
       AND (NOT $2 OR iv.branch_id = ANY($3::uuid[]))
       AND ($4 = '' OR iv.code ILIKE '%' || $4 || '%'
                    OR iv.name::text ILIKE '%' || $4 || '%'
                    OR cat.name::text ILIKE '%' || $4 || '%')
     ORDER BY cat.name, iv.sort_order, iv.code`,
    [opts.tenantId, scoped, opts.branchIds ?? [], q],
  )

  const locale = opts.locale ?? 'ru'
  return rows.map((r) => ({
    variantId: r.variant_id as string,
    code: r.code as string,
    name: localized(r.name as I18nField, locale, r.code as string),
    categoryCode: r.category_code as string,
    categoryName: localized(r.category_name as I18nField, locale, r.category_code as string),
    branchId: r.branch_id as string,
    branchName: r.branch_name as string,
    inventoryMode: r.inventory_mode as string,
    total: (r.total as number) ?? 0,
    bookedAhead: (r.booked_ahead as number) ?? 0,
    nearestBookingAt: (r.nearest_booking_at as Date) ?? null,
  }))
}
