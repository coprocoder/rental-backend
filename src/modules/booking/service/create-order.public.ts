/**
 * Создание заказа.
 * POST /api/v1/public/orders
 *
 * ⚠️ Идемпотентен по Idempotency-Key: мобильная связь рвётся, форма
 * отправляется дважды — без этого клиент получит две брони.
 *
 * ⚠️ Наличие проверяется ПОВТОРНО: между выбором и подтверждением
 * проходят минуты, за которые вещь могут забрать.
 */
import type { Deps } from '~/kernel/deps'
import * as v from 'valibot'
import { canonicalPhone } from '~/common/utils/phone'
import { apiError, mapDbError } from '~/kernel/errors'
import { checkAvailability, reservePool, bufferMinutesFor } from '~/domain/availability/availability'
import { quote } from '~/domain/pricing/pricing'
import type { DayMode } from '~/common/contract/day-count'
import { confirmDeadline } from '~/domain/orders/confirm-deadline'
import { describeSeason, seasonAllows } from '~/common/contract/season'
import { issueOrderTokens } from '~/domain/orders/order-token'
import { recordRefusalDetached } from '~/domain/availability/demand'
import {
  assertCanCreateOrder,
  checkPlanLimit,
  entitlementsFor,
} from '~/domain/core/entitlements'
import { activeFlags, isEnabled } from '~/domain/core/flags'
import { applyBuffer, checkBusinessHours } from '~/domain/availability/schedule'
import {
  checkActiveOrders,
  checkAdvanceDays,
  checkPoolShare,
  describeViolation,
  getLimits,
} from '~/domain/pricing/limits'

const Body = v.object({
  tenant: v.pipe(v.string(), v.minLength(1)),
  branchId: v.pipe(v.string(), v.uuid()),
  from: v.pipe(v.string(), v.isoTimestamp()),
  to: v.pipe(v.string(), v.isoTimestamp()),
  name: v.pipe(v.string(), v.minLength(2)),
  // ⚠️ Приводим к канонической форме ПРЯМО В СХЕМЕ: дальше по коду
  // ходит уже +7XXXXXXXXXX. Иначе «+7 999…» и «8999…» создают двух
  // клиентов, и лимит активных броней обходится сменой формата.
  phone: v.pipe(
    v.string(),
    v.transform(canonicalPhone),
    v.check((x) => x.length === 12, 'Телефон в формате +7XXXXXXXXXX'),
  ),
  email: v.optional(v.string()),
  body: v.optional(v.record(v.string(), v.number())),
  /** Услуги без интервала: заточка, парафин. Наличие и сезон не проверяются. */
  services: v.optional(v.array(v.object({
    variantId: v.pipe(v.string(), v.uuid()),
    qty: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(20)),
  }))),
  lines: v.pipe(v.array(v.object({
    variantId: v.pipe(v.string(), v.uuid()),
    qty: v.pipe(v.number(), v.integer(), v.minValue(1)),
  })), v.minLength(1)),
  // Согласия: ⚠️ факт пишется в БД, сам чекбокс ничего не доказывает.
  consentPersonalData: v.literal(true),
  consentTerms: v.literal(true),
  savePar: v.optional(v.boolean()),
})

/** Короткий человекочитаемый номер заказа для поиска на стойке. */
function publicCode(): string {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

export interface PostOrdersInput {
  ip: string
  body: unknown
  headers: Record<string, string | undefined>
}

export async function postOrders(
  req: PostOrdersInput,
  deps: Deps,
) {
  const parsed = v.safeParse(Body, req.body)
  if (!parsed.success) {
    throw apiError('VALIDATION_FAILED', 'Проверьте заполнение полей', {
      issues: parsed.issues.map((i) => ({ path: i.path?.map((p) => p.key).join('.'), message: i.message })),
    })
  }
  const input = parsed.output
  const idemKey = req.headers['idempotency-key'] ?? null

  const tenants = await deps.db.unscoped<{ id: string, day_mode: string, group_threshold: number, paid_until: Date | null }>(
    `SELECT id, day_mode, group_threshold, paid_until FROM tenant
     WHERE slug = $1 AND archived_at IS NULL`,
    [input.tenant],
  )
  const tenant = tenants[0]
  if (!tenant) throw apiError('TENANT_NOT_FOUND', 'Прокат не найден')

  const branches = await deps.db.tx(tenant.id, async (c) => {
    const { rows } = await c.query<{ timezone: string }>(
      `SELECT timezone FROM branch WHERE id = $1 AND tenant_id = $2`,
      [input.branchId, tenant.id],
    )
    return rows
  })
  const timezone = branches[0]?.timezone
  if (!timezone) throw apiError('NOT_FOUND', 'Филиал не найден')

  const from = new Date(input.from)
  const to = new Date(input.to)
  // Сквозной идентификатор: связывает событие заказа, запись отказа
  // и строку в outbox между собой и с логами воркера.
  const cid = req.headers?.["x-correlation-id"]
  const totalQty = input.lines.reduce((s, l) => s + l.qty, 0)

  // ⚠️ Порог группы: выше — заказ создаётся, но инвентарь НЕ удерживает
  // до подтверждения оператором. Это бронь с отложенным декрементом,
  // а не заявка вместо брони: клиент получает номер и понимает,
  // что его услышали.
  const isGroup = totalQty > tenant.group_threshold

  try {
    return await deps.db.tx(tenant.id, async (c) => {
      // Идемпотентность: тот же ключ → тот же заказ.
      if (idemKey) {
        const existing = await c.query<{ public_code: string, status: string }>(
          `SELECT public_code, status FROM rental_order
           WHERE tenant_id = $1 AND price_breakdown->>'idemKey' = $2`,
          [tenant.id, idemKey],
        )
        if (existing.rows[0]) {
          return { code: existing.rows[0].public_code, status: existing.rows[0].status, repeated: true }
        }
      }

      // ⚠️ Подписка проверяется ТОЛЬКО на создание новой брони.
      // Выдача, возврат, подтверждение и отмена существующих заказов
      // работают всегда: клиенты проката не должны страдать из-за
      // расчётов между прокатом и платформой.
      const ent = await entitlementsFor(c, tenant.id)
      assertCanCreateOrder(ent)

      // ⚠️ Рубильник онлайн-бронирования (17.19) — отдельно от тарифа:
      // прокат гасит приём заказов на инвентаризацию или на время
      // аварии, не меняя план. Существующие заказы это не трогает:
      // выдача, возврат и отмена работают всегда.
      const flags = await activeFlags(c, tenant.id)
      if (!isEnabled(flags, 'online_booking', true)) {
        throw apiError('TENANT_SUSPENDED',
          'Онлайн-бронирование временно приостановлено прокатом. Позвоните — заказ оформят на месте.')
      }

      // Лимит заказов в месяц — ось тарификации.
      const monthly = await checkPlanLimit(c, {
        tenantId: tenant.id, kind: 'orders_per_month', entitlements: ent,
      })
      if (!monthly.ok) {
        throw apiError('LIMIT_EXCEEDED',
          'Достигнут лимит заказов в месяц по текущему тарифу',
          { current: monthly.current, allowed: monthly.allowed })
      }

      // Лимиты тенанта. ⚠️ Лимита позиций в заказе нет: он режет
      // честные крупные заказы. Работают механизмы, не зависящие от
      // размера — доля пула, глубина вперёд, число активных броней.
      const limits = await getLimits(c, tenant.id)

      const advance = checkAdvanceDays({
        from, now: new Date(), timezone, allowed: limits.maxAdvanceDays,
      })
      if (advance) {
        await recordRefusalDetached({
          tenantId: tenant.id, branchId: input.branchId, reason: 'limit_exceeded',
          from, to, bodyParams: input.body, correlationId: cid,
        })
        throw apiError('LIMIT_EXCEEDED', describeViolation(advance), { violation: advance })
      }

      const active = await checkActiveOrders(c, {
        tenantId: tenant.id, phone: input.phone, allowed: limits.maxActiveOrders,
      })
      if (active) {
        await recordRefusalDetached({
          tenantId: tenant.id, branchId: input.branchId, reason: 'limit_exceeded',
          from, to, bodyParams: input.body, correlationId: cid,
        })
        throw apiError('LIMIT_EXCEEDED', describeViolation(active), { violation: active })
      }

      for (const l of input.lines) {
        const share = await checkPoolShare(c, {
          tenantId: tenant.id,
          variantId: l.variantId,
          qty: l.qty,
          sharePercent: limits.poolSharePercent,
        })
        if (share) {
          await recordRefusalDetached({
            tenantId: tenant.id, branchId: input.branchId, variantId: l.variantId,
            reason: 'limit_exceeded', from, to, bodyParams: input.body, correlationId: cid,
          })
          throw apiError('LIMIT_EXCEEDED', describeViolation(share), { violation: share })
        }
      }

      // Часы работы: обе границы аренды. Здесь отказ уместен —
      // заказ на закрытый день означает, что клиент приедет к
      // запертой двери.
      const hours = await checkBusinessHours(c, {
        branchId: input.branchId, from, to, timezone,
      })
      if (!hours.ok) {
        const p = hours.problems[0]!
        await recordRefusalDetached({
          tenantId: tenant.id, branchId: input.branchId, reason: 'outside_hours',
          from, to, bodyParams: input.body, correlationId: cid,
        })
        throw apiError(
          'OUTSIDE_BUSINESS_HOURS',
          p.reason === 'off_season'
            ? 'Филиал в это время года не работает'
            : p.reason === 'closed_day'
              ? `${p.which === 'pickup' ? 'Выдача' : 'Возврат'} приходится на нерабочий день`
              : `${p.which === 'pickup' ? 'Выдача' : 'Возврат'} вне часов работы (${p.opensAt}–${p.closesAt})`,
          { problems: hours.problems },
        )
      }

      // Сезон КАТЕГОРИИ на дату начала аренды — ось, независимая от
      // филиала. Каталог несезонное не показывает, но прямой запрос к
      // API обязан отвечать тем же: «сноуборд + сапборд на 15 января»
      // не должен проходить только потому, что обошли форму.
      //
      // ⚠️ Это проверка ПУБЛИЧНОГО пути. На стойке (walk-in) сезон не
      // проверяется намеренно: в межсезонье бывают и лыжи на ледник, и
      // сапборд на озере, и у оператора вещь в руках — то же правило,
      // что «расхождение не блокирует выдачу».
      const { rows: seasons } = await c.query<{
        variant_id: string
        code: string
        name: { ru?: string }
        season_from_month: number | null
        season_to_month: number | null
      }>(
        `SELECT v.id AS variant_id, c.code, c.name, c.season_from_month, c.season_to_month
         FROM inventory_variant v JOIN category c ON c.id = v.category_id
         WHERE v.id = ANY($1::uuid[])`,
        [input.lines.map((l) => l.variantId)],
      )
      for (const sc of seasons) {
        const season = { fromMonth: sc.season_from_month, toMonth: sc.season_to_month }
        if (!seasonAllows(from, season, timezone)) {
          await recordRefusalDetached({
            tenantId: tenant.id, branchId: input.branchId, variantId: sc.variant_id,
            reason: 'out_of_season', from, to, bodyParams: input.body, correlationId: cid,
          })
          throw apiError(
            'OUT_OF_SEASON',
            `${sc.name?.ru ?? sc.code}: не в сезоне на выбранные даты (сезон ${describeSeason(season)})`,
            { variantId: sc.variant_id, categoryCode: sc.code, season: describeSeason(season) },
          )
        }
      }

      // ⚠️ Повторная проверка наличия — вещь могли забрать.
      if (!isGroup) {
        for (const l of input.lines) {
          // ⚠️ Тот же интервал, что и при занятии: иначе проверка
          // разрешит бронь, которую занятие отвергнет по CHECK.
          const buffer = await bufferMinutesFor(c, l.variantId)
          const a = await checkAvailability(c, {
            tenantId: tenant.id,
            variantId: l.variantId,
            from,
            to: applyBuffer(to, buffer),
            timezone,
            qty: l.qty,
          })
          if (!a.available) {
            // Предлагаем альтернативы, а не просто отказываем.
            const alts = await c.query<{ id: string, name: { ru?: string } }>(
              `SELECT v2.id, v2.name FROM inventory_variant v1
               JOIN inventory_variant v2 ON v2.category_id = v1.category_id AND v2.id <> v1.id
               WHERE v1.id = $1 AND v2.archived_at IS NULL LIMIT 3`,
              [l.variantId],
            )
            // ⚠️ Главная точка сбора данных для закупки: сколько людей
            // и с какими параметрами ушли ни с чем. Без этой записи
            // отказ не оставляет следа, и прокат не знает, чего ему
            // не хватает.
            await recordRefusalDetached({
              tenantId: tenant.id,
              branchId: input.branchId,
              variantId: l.variantId,
              reason: 'no_availability',
              from, to,
              bodyParams: input.body,
              correlationId: cid,
              // Оценка по прайсу на дату отказа — именно оценка,
              // человек мог бы и не оформить заказ.
              estimatedAmount: (await quote(c, {
                tenantId: tenant.id, lines: [l], from, to,
                dayMode: tenant.day_mode as DayMode, timezone,
              })).total,
            })
            throw apiError('POOL_EXHAUSTED', 'На выбранные даты не хватает свободных единиц', {
              variantId: l.variantId,
              shortageDays: a.shortageDays,
              alternatives: alts.rows.map((r) => ({ id: r.id, name: r.name?.ru })),
              // ⚠️ Отказ обязан предлагать лист ожидания: иначе клиент
              // уходит навсегда, а инвентарь через час освобождается —
              // и предложить его некому. Плюс это единственный источник
              // данных о неудовлетворённом спросе для закупки.
              canJoinWaitlist: true,
            })
          }
        }
      }

      const serviceLines = (input.services ?? []).map((sv) => ({ ...sv, kind: 'service' as const }))
      const priced = await quote(c, {
        tenantId: tenant.id,
        lines: [...input.lines, ...serviceLines],
        from, to,
        dayMode: tenant.day_mode as DayMode, timezone,
      })

      // Клиент по телефону: без него счётчик неявок сбрасывался бы.
      const { rows: [customer] } = await c.query<{ id: string }>(
        `INSERT INTO customer (tenant_id, phone, name, email, body_params)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, phone) DO UPDATE
           SET name = excluded.name,
               email = COALESCE(excluded.email, customer.email),
               body_params = CASE WHEN $6 THEN excluded.body_params ELSE customer.body_params END
         RETURNING id`,
        [tenant.id, input.phone, input.name, input.email ?? null,
         req.body ? JSON.stringify(req.body) : null, input.savePar === true],
      )

      const code = publicCode()
      const status = isGroup ? 'awaiting_stock' : 'awaiting_confirm'

      // Дедлайн подтверждения из настроек тенанта. Для брони «на сегодня»
      // возвращается null — автоснятия у неё нет по ТЗ, снимает оператор.
      // Обоснование целиком — shared/confirm-deadline.ts.
      const deadline = confirmDeadline(from, timezone, new Date(), limits.confirmDeadlineHours)

      const { rows: [order] } = await c.query<{ id: string }>(
        `INSERT INTO rental_order
           (tenant_id, public_code, branch_pickup_id, customer_id, status, period,
            hold_expires_at, confirm_deadline, total_amount, price_breakdown, retention_until)
         VALUES ($1, $2, $3, $4, $5, tstzrange($6, $7),
                 now() + interval '20 minutes', $8, $9, $10, now() + interval '3 years')
         RETURNING id`,
        [tenant.id, code, input.branchId, customer!.id, status, from, to,
         deadline, priced.total,
         JSON.stringify({ ...priced, idemKey })],
      )
      const orderId = order!.id

      for (const [i, l] of input.lines.entries()) {
        await c.query(
          `INSERT INTO order_line (tenant_id, order_id, kind, variant_id, qty, period, amount)
           VALUES ($1, $2, 'rental', $3, $4, tstzrange($5, $6), $7)`,
          [tenant.id, orderId, l.variantId, l.qty, from, to,
           priced.breakdown[i]?.lineTotal ?? null],
        )

        // Инвентарь удерживается только для обычных заказов.
        if (!isGroup) {
          // ⚠️ Пул занимается с буфером категории: ботинкам нужна
          // просушка, и следующая выдача не должна попадать в это
          // время. Буфер расширяет интервал, а не меняет оператор.
          const buffer = await bufferMinutesFor(c, l.variantId)
          await reservePool(c, {
            tenantId: tenant.id,
            variantId: l.variantId,
            from,
            to: applyBuffer(to, buffer),
            timezone,
            qty: l.qty,
          })
        }
      }

      // Строки услуг: kind = 'service', БЕЗ периода — у заточки нет
      // интервала, и EXCLUDE по (item_id, period) её не касается.
      // Пул не занимается: услуга не расходует инвентарь.
      for (const [j, sv] of serviceLines.entries()) {
        await c.query(
          `INSERT INTO order_line (tenant_id, order_id, kind, variant_id, qty, amount)
           VALUES ($1, $2, 'service', $3, $4, $5)`,
          [tenant.id, orderId, sv.variantId, sv.qty,
           priced.breakdown[input.lines.length + j]?.lineTotal ?? null],
        )
      }

      // Согласия: время, версия текста, IP.
      //
      // ⚠️ save_params пишется отдельным согласием, а не только флагом
      // на клиенте: параметры тела подставляются повторному клиенту
      // ТОЛЬКО при действующем согласии, и проверяется именно запись
      // в consent. Без неё узнавание клиента молча не работало бы —
      // граница соблюдена, но данных для неё нет.
      const kinds: ('personal_data' | 'terms' | 'save_params')[] =
        ['personal_data', 'terms']
      if (input.savePar === true) kinds.push('save_params')

      for (const kind of kinds) {
        await c.query(
          `INSERT INTO consent (tenant_id, order_id, customer_id, kind, text_version, ip, user_agent)
           VALUES ($1, $2, $3, $4, 'v1', $5, $6)`,
          [tenant.id, orderId, customer!.id, kind,
           req.ip ?? null,
           req.headers['user-agent'] ?? null],
        )
      }

      // Журнал событий: пишется в ТОЙ ЖЕ транзакции.
      await c.query(
        `INSERT INTO event
           (tenant_id, aggregate_type, aggregate_id, kind, payload,
            correlation_id, actor_type)
         VALUES ($1, 'rental_order', $2, 'order.created', $3, $4, 'customer')`,
        [tenant.id, orderId,
         JSON.stringify({ code, total: priced.total, isGroup }), cid ?? null],
      )

      // Токены доступа клиента: свой на просмотр, подтверждение и отмену.
      // ⚠️ Разные, чтобы утечка ссылки «посмотреть» не давала отменить.
      const tokens = await issueOrderTokens(c, {
        tenantId: tenant.id, orderId, rentalEnd: to,
      })

      // Outbox: уведомление не отправляется из транзакции.
      // ⚠️ Токены кладутся в payload, потому что в БД лежат только их
      // хеши — восстановить их позже невозможно, и другого шанса
      // вложить ссылку в письмо не будет.
      await c.query(
        `INSERT INTO outbox
           (tenant_id, kind, payload, idempotency_key, correlation_id)
         VALUES ($1, 'order.confirm_link', $2, $3, $4)`,
        [tenant.id, JSON.stringify({
          orderId, code, phone: input.phone, email: input.email ?? null,
          tokens, needsOperator: isGroup,
        }), `confirm:${orderId}`, cid ?? null],
      )

      return {
        code,
        status,
        total: priced.total,
        days: priced.days,
        needsOperator: isGroup,
        // ⚠️ Отдаём наружу, потому что интерфейс обещает клиенту
        // именно этот срок. Без него страница обещала бы дедлайн,
        // которого у брони на сегодня нет.
        confirmDeadline: deadline?.toISOString() ?? null,
        // Ссылки клиента. Показываются сразу: в MVP уведомления идут
        // через outbox, но обработчик может отстать, а заказ уже нужен.
        links: {
          view: `/o/${tokens.view}`,
          confirm: `/o/${tokens.confirm}/confirm`,
          cancel: `/o/${tokens.cancel}/cancel`,
        },
      }
    })
  } catch (err) {
    throw mapDbError(err)
  }
}
