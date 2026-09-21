/**
 * Отметить возврат.
 *
 * ⚠️ Возврат может быть частичным: тогда заказ идёт в
 * partially_returned, и освобождаются только вернувшиеся позиции.
 *
 * ⚠️ Перерасчёт при досрочном возврате обязателен по ГК ст. 630 —
 * считается по снимку правил заказа (server/domain/recalc.ts).
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import * as v from 'valibot'
import { apiError, mapDbError } from '~/kernel/errors'
import { returnOrder } from '~/domain/counter/counter'
import { recalculate, type SnapshotLine } from '~/domain/orders/recalc'
import type { DayMode } from '~/common/contract/day-count'

export const ReturnBody = v.object({
  orderId: v.pipe(v.string(), v.uuid()),
  lines: v.pipe(v.array(v.object({
    orderLineId: v.pipe(v.string(), v.uuid()),
    qty: v.pipe(v.number(), v.integer(), v.minValue(1)),
    condition: v.optional(v.picklist(['ok', 'damaged', 'lost'])),
    serviceKind: v.optional(v.picklist([
      'drying', 'sharpening', 'wax', 'repair', 'inspection', 'other',
    ])),
  })), v.minLength(1)),
})

export interface PostReturnRequest {
  body: unknown
}

export async function postReturn(
  session: Session,
  req: PostReturnRequest,
  deps: Deps,
) {

  const parsed = v.safeParse(ReturnBody, req.body)
  if (!parsed.success) throw apiError('VALIDATION_FAILED', 'Проверьте данные возврата')

  try {
    return await deps.db.tx(session.tenantId, async (c) => {
      const result = await returnOrder(c, {
        tenantId: session.tenantId,
        orderId: parsed.output.orderId,
        staffId: session.activeStaffId,
        lines: parsed.output.lines,
      })

      // Перерасчёт: считается по СНИМКУ, не по текущему прайсу.
      const { rows } = await c.query<{
        price_breakdown: { breakdown?: SnapshotLine[], days?: number } | null
        total_amount: string | null
        starts_at: Date
        ends_at: Date
        day_mode: DayMode
        timezone: string
      }>(
        `SELECT o.price_breakdown, o.total_amount,
                lower(o.period) AS starts_at, upper(o.period) AS ends_at,
                t.day_mode, b.timezone
         FROM rental_order o
         JOIN tenant t ON t.id = o.tenant_id
         JOIN branch b ON b.id = o.branch_pickup_id
         WHERE o.id = $1`,
        [parsed.output.orderId],
      )
      const order = rows[0]
      const snapshot = order?.price_breakdown?.breakdown ?? []

      // Без снимка пересчитывать нечего: заказ создан до движка цен
      // или это выдача «с улицы» без прайса.
      if (!order || !snapshot.length || !order.total_amount) {
        return { ...result, recalc: null }
      }

      // ⚠️ Снимок ключуется по variantId, а строка возврата ссылается
      // на order_line. Без сопоставления перерасчёт не нашёл бы ни
      // одной позиции и вернул бы полную сумму — то есть молча не
      // сделал бы то, что обязателен делать по закону.
      const { rows: lineMap } = await c.query<{ id: string, variant_id: string }>(
        `SELECT id, variant_id FROM order_line
         WHERE order_id = $1 AND id = ANY($2::uuid[])`,
        [parsed.output.orderId, parsed.output.lines.map((l) => l.orderLineId)],
      )
      const variantByLine = new Map(lineMap.map((r) => [r.id, r.variant_id]))

      const returnedAt = new Date()
      const recalc = recalculate({
        snapshot,
        originalTotal: order.total_amount,
        from: order.starts_at,
        originalTo: order.ends_at,
        returns: parsed.output.lines.flatMap((l) => {
          const variantId = variantByLine.get(l.orderLineId)
          return variantId ? [{ variantId, returnedAt, qty: l.qty }] : []
        }),
        dayMode: order.day_mode,
        timezone: order.timezone,
      })

      return { ...result, recalc }
    })
  } catch (err) {
    throw mapDbError(err)
  }
}
