/**
 * Выдача «с улицы» — человек пришёл без брони.
 *
 * ⚠️ Это кнопка ПЕРВОГО уровня, а не спрятанная функция
 * (../rental-docs/docs/04-тз/20-фронтенд/24-стойка.md). Если оформить такую выдачу неудобно,
 * сотрудник обойдёт систему, и в первый же выходной наличие начнёт
 * врать по всему складу — а не только по этим заказам.
 *
 * Поэтому обязательных полей минимум: телефон и имя НЕ требуются.
 * Человек стоит у стойки, и требовать контакт ради учёта — тот же
 * барьер, что и запрет выдачи при расхождении.
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import * as v from 'valibot'
import { canonicalPhone } from '~/common/utils/phone'
import { apiError, mapDbError } from '~/kernel/errors'
import { canAccessBranch } from '~/domain/core/auth'
import { walkInOrder } from '~/domain/counter/counter'
import { quote } from '~/domain/pricing/pricing'
import type { DayMode } from '~/common/contract/day-count'

export const WalkInBody = v.object({
  branchId: v.pipe(v.string(), v.uuid()),
  from: v.pipe(v.string(), v.isoTimestamp()),
  to: v.pipe(v.string(), v.isoTimestamp()),
  name: v.optional(v.pipe(v.string(), v.maxLength(200))),
  // ⚠️ Необязателен (человек с улицы может не назвать), но если
  // назван — приводится к канону: иначе тот же клиент в следующий раз
  // не узнается, и история аренд разорвётся.
  phone: v.optional(v.pipe(
    v.string(),
    v.transform(canonicalPhone),
    v.check((x) => x === '' || x.length === 12, 'Телефон в формате +7XXXXXXXXXX'),
  )),
  lines: v.pipe(v.array(v.object({
    variantId: v.pipe(v.string(), v.uuid()),
    qty: v.pipe(v.number(), v.integer(), v.minValue(1)),
  })), v.minLength(1)),
})

export interface PostWalkInRequest {
  body: unknown
}

export async function postWalkIn(
  session: Session,
  req: PostWalkInRequest,
  deps: Deps,
) {

  const parsed = v.safeParse(WalkInBody, req.body)
  if (!parsed.success) throw apiError('VALIDATION_FAILED', 'Проверьте данные выдачи')
  const input = parsed.output

  if (!canAccessBranch(session, input.branchId)) {
    throw apiError('FORBIDDEN', 'Этот филиал вам недоступен')
  }

  const from = new Date(input.from)
  const to = new Date(input.to)

  try {
    return await deps.db.tx(session.tenantId, async (c) => {
      const { rows } = await c.query<{ day_mode: DayMode, timezone: string }>(
        `SELECT t.day_mode, b.timezone
         FROM tenant t JOIN branch b ON b.id = $2
         WHERE t.id = $1`,
        [session.tenantId, input.branchId],
      )
      const cfg = rows[0]
      if (!cfg) throw apiError('NOT_FOUND', 'Филиал не найден')

      // Цена считается тем же движком, что и для онлайн-заказа:
      // выдача «с улицы» не должна стоить иначе — публичный договор
      // требует равных условий.
      const priced = await quote(c, {
        tenantId: session.tenantId,
        lines: input.lines,
        from, to,
        dayMode: cfg.day_mode,
        timezone: cfg.timezone,
      })

      const created = await walkInOrder(c, {
        tenantId: session.tenantId,
        branchId: input.branchId,
        staffId: session.activeStaffId,
        from, to,
        name: input.name,
        phone: input.phone,
        lines: input.lines.map((l, i) => ({
          variantId: l.variantId,
          qty: l.qty,
          amount: priced.breakdown[i]?.lineTotal,
        })),
        total: priced.total,
      })

      return { ...created, total: priced.total, days: priced.days }
    })
  } catch (err) {
    throw mapDbError(err)
  }
}
