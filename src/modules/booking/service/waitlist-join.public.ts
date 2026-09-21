/**
 * Запись в лист ожидания при отсутствии наличия.
 *
 * Смысл (../rental-docs/docs/04-тз/10-бэкенд/22-лист-ожидания.md): сейчас клиент видит
 * «занято» и уходит, а инвентарь через час освобождается — и предложить
 * его некому. Отказ теряет и клиента, и выручку.
 *
 * ⚠️ Запись НЕ удерживает инвентарь, поэтому эндпоинт не проверяет
 * лимиты и не занимает пул: захватить арсенал листом ожидания нельзя
 * по построению.
 *
 * ⚠️ Никакого приоритета: очередь строго по времени записи. Публичный
 * договор требует равных условий (ГК ст. 626 п. 3), поэтому «вперёд за
 * подписку» или «постоянным клиентам» здесь незаконно.
 */
import type { Deps } from '~/kernel/deps'
import * as v from 'valibot'
import { canonicalPhone } from '~/common/utils/phone'
import { apiError, mapDbError } from '~/kernel/errors'
import { addToWaitlist } from '~/domain/availability/waitlist'

const Body = v.object({
  tenant: v.pipe(v.string(), v.minLength(1)),
  branchId: v.pipe(v.string(), v.uuid()),
  variantId: v.pipe(v.string(), v.uuid()),
  from: v.pipe(v.string(), v.isoTimestamp()),
  to: v.pipe(v.string(), v.isoTimestamp()),
  /**
   * «Любая дата в диапазоне» (17.14): границы, в которых клиент
   * согласен взять снаряжение.
   *
   * ⚠️ Не заменяют from/to, а дополняют их: from/to — сколько и когда
   * хочется, диапазон — где допустимо подвинуть. Без них ждём ровно
   * запрошенные даты, как раньше.
   */
  searchFrom: v.optional(v.pipe(v.string(), v.isoTimestamp())),
  searchTo: v.optional(v.pipe(v.string(), v.isoTimestamp())),
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  phone: v.pipe(
    v.string(),
    v.transform(canonicalPhone),
    v.check((x) => x.length === 12, 'Телефон в формате +7XXXXXXXXXX'),
  ),
  email: v.optional(v.pipe(v.string(), v.email())),
  /** Согласие на обработку ПД обязательно и здесь: это контактные данные. */
  consentPersonalData: v.literal(true),
})

export interface PostWaitlistInput {
  body: unknown
  /**
   * ⚠️ IP и user-agent нужны для записи согласия на обработку ПД: это
   * доказательство того, кто и откуда его дал. Ставит транспорт —
   * сервис о существовании HTTP не знает.
   */
  ip: string
  userAgent: string | undefined
}

export async function postWaitlist(req: PostWaitlistInput, deps: Deps) {
  const parsed = v.safeParse(Body, req.body)
  if (!parsed.success) {
    throw apiError('VALIDATION_FAILED', 'Проверьте заполненные поля', {
      issues: parsed.issues.map((i) => i.path?.map((p) => p.key).join('.')),
    })
  }
  const input = parsed.output

  const tenants = await deps.db.unscoped<{ id: string }>(
    `SELECT id FROM tenant WHERE slug = $1 AND archived_at IS NULL`,
    [input.tenant],
  )
  const tenantId = tenants[0]?.id
  if (!tenantId) throw apiError('TENANT_NOT_FOUND', 'Прокат не найден')

  const from = new Date(input.from)
  const to = new Date(input.to)
  const searchFrom = input.searchFrom ? new Date(input.searchFrom) : undefined
  const searchTo = input.searchTo ? new Date(input.searchTo) : undefined

  // Ждать прошедшую дату бессмысленно: запись истекла бы сразу.
  if (from.getTime() <= deps.clock().getTime()) {
    throw apiError('VALIDATION_FAILED', 'Дата начала уже прошла')
  }

  // ⚠️ Диапазон задаётся целиком или не задаётся вовсе: одна граница
  // означает «когда угодно после» — то есть бессрочное ожидание,
  // которого механика не предусматривает.
  if ((searchFrom === undefined) !== (searchTo === undefined)) {
    throw apiError('VALIDATION_FAILED', 'Диапазон задаётся обеими границами')
  }
  if (searchFrom && searchTo && (searchFrom > from || searchTo < to)) {
    throw apiError('VALIDATION_FAILED', 'Диапазон поиска уже выбранных дат')
  }

  try {
    return await deps.db.tx(tenantId, async (c) => {
      const { rows: [customer] } = await c.query<{ id: string }>(
        `INSERT INTO customer (tenant_id, phone, name, email)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, phone) DO UPDATE
           SET name = excluded.name,
               email = COALESCE(excluded.email, customer.email)
         RETURNING id`,
        [tenantId, input.phone, input.name, input.email ?? null],
      )

      const waitlistId = await addToWaitlist(c, {
        tenantId,
        branchId: input.branchId,
        variantId: input.variantId,
        customerId: customer!.id,
        from,
        to,
        searchFrom,
        searchTo,
      })

      // Факт согласия — в БД: чекбокс без записи ничего не доказывает.
      await c.query(
        `INSERT INTO consent (tenant_id, customer_id, kind, text_version, ip, user_agent)
         VALUES ($1, $2, 'personal_data', 'v1', $3, $4)`,
        [tenantId, customer!.id,
         req.ip ?? null,
         req.userAgent ?? null],
      )

      // ⚠️ Событие отказа — источник данных для закупки: без него
      // неудовлетворённый спрос не оставляет следа.
      await c.query(
        `INSERT INTO event (tenant_id, aggregate_type, aggregate_id, kind, payload, actor_type)
         VALUES ($1, 'waitlist', $2, 'waitlist.joined', $3, 'customer')`,
        [tenantId, waitlistId,
         JSON.stringify({
           variantId: input.variantId,
           from: input.from,
           to: input.to,
           // ⚠️ Гибкость записывается в событие: для закупки важно
           // отличать «нужна была именно суббота» от «взял бы любой
           // день недели» — это разный дефицит.
           searchFrom: input.searchFrom ?? null,
           searchTo: input.searchTo ?? null,
         })],
      )

      return {
        ok: true,
        /** Позиция в очереди — клиенту важно понимать, чего ждать. */
        position: await positionInQueue(c, tenantId, input.variantId, waitlistId),
      }
    })
  } catch (err) {
    throw mapDbError(err)
  }
}

/** Какой по счёту в очереди на этот вариант. */
async function positionInQueue(
  c: import('pg').PoolClient,
  tenantId: string,
  variantId: string,
  waitlistId: string,
): Promise<number> {
  const { rows } = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n
     FROM waitlist
     WHERE tenant_id = $1 AND variant_id = $2 AND status = 'waiting'
       AND created_at <= (SELECT created_at FROM waitlist WHERE id = $3)`,
    [tenantId, variantId, waitlistId],
  )
  return rows[0]?.n ?? 1
}
