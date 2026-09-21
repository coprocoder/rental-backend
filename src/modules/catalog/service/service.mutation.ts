/**
 * Завершить обслуживание: вернуть вещь в оборот.
 *
 * ⚠️ Это закрывает настоящий дефект, а не добавляет удобство. Вещь
 * уходила в обслуживание при возврате повреждённой (стойка пишет
 * `to_service`), а обратного пути НЕ БЫЛО: функция возврата была
 * написана и никем не вызывалась. В демо-данных четыре единицы ушли
 * в сервис и ни одна не вернулась — каждая поломка навсегда
 * уменьшала склад.
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import * as v from 'valibot'
import { apiError, mapDbError } from '~/kernel/errors'
import { finishService } from '~/domain/service/service'
import { audit } from '~/domain/core/order-lifecycle'

export const ServiceBody = v.object({
  variantId: v.pipe(v.string(), v.uuid()),
  branchId: v.pipe(v.string(), v.uuid()),
  qty: v.pipe(v.number(), v.integer(), v.minValue(1)),
  /** Конкретная вещь при поимённом учёте. */
  itemId: v.optional(v.nullable(v.pipe(v.string(), v.uuid()))),
  /** Что сделали — попадёт в историю вещи. */
  note: v.optional(v.pipe(v.string(), v.maxLength(200))),
})

export interface PostServiceRequest {
  body: unknown
}

export async function postService(
  session: Session,
  req: PostServiceRequest,
  deps: Deps,
) {
  const parsed = v.safeParse(ServiceBody, req.body)
  if (!parsed.success) throw apiError('VALIDATION_FAILED', 'Проверьте позицию и количество')
  const input = parsed.output

  // ⚠️ Филиал проверяется по доступным сотруднику: подставить чужой id
  // и вернуть в оборот вещь на чужой точке нельзя.
  const all = session.activeRole === 'owner' || session.activeRole === 'admin'
  if (!all && !session.branchIds.includes(input.branchId)) {
    throw apiError('FORBIDDEN', 'Филиал недоступен')
  }

  try {
    return await deps.db.tx(session.tenantId, async (c) => {
      const res = await finishService(c, {
        tenantId: session.tenantId,
        branchId: input.branchId,
        variantId: input.variantId,
        qty: input.qty,
        itemId: input.itemId ?? null,
        note: input.note,
        staffId: session.activeStaffId,
      })

      if (res.returned === 0) {
        throw apiError('VALIDATION_FAILED', 'Эта позиция уже вернулась в оборот')
      }

      await audit(c, {
        tenantId: session.tenantId,
        staffId: session.activeStaffId,
        action: 'service.finished',
        targetType: input.itemId ? 'item' : 'inventory_variant',
        targetId: input.itemId ?? input.variantId,
        after: { qty: res.returned, branchId: input.branchId, note: input.note ?? null },
      })

      return res
    })
  } catch (err) {
    throw mapDbError(err)
  }
}
