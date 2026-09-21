/**
 * Настройка резерва под выдачу без связи (10.10).
 *
 * ⚠️ Ноль ОЗНАЧАЕТ «резерва нет» и удаляет строку, а не пишет нулевую:
 * иначе таблица со временем наполняется нулями, и по ней нельзя
 * отличить «настроили и выключили» от «не настраивали».
 *
 * ⚠️ Процент ограничен сверху: резерв в 100% означает, что онлайн
 * нельзя забронировать ничего, и витрина показывает пустой каталог
 * при полном складе. Это выглядит как поломка системы, а не как
 * настройка, и в поддержку придут к нам.
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import * as v from 'valibot'
import { apiError, mapDbError } from '~/kernel/errors'
import { canAccessBranch } from '~/domain/core/auth'
import { audit } from '~/domain/core/order-lifecycle'

export const OfflineReserveBody = v.object({
  branchId: v.pipe(v.string(), v.uuid()),
  categoryId: v.pipe(v.string(), v.uuid()),
  mode: v.picklist(['percent', 'absolute']),
  value: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1000)),
})

export interface PostOfflineReserveRequest {
  body: unknown
}

export async function postOfflineReserve(
  session: Session,
  req: PostOfflineReserveRequest,
  deps: Deps,
) {

  const parsed = v.safeParse(OfflineReserveBody, req.body)
  if (!parsed.success) throw apiError('VALIDATION_FAILED', 'Проверьте данные резерва')
  const input = parsed.output

  if (!canAccessBranch(session, input.branchId)) {
    throw apiError('FORBIDDEN', 'Этот филиал вам недоступен')
  }
  if (input.mode === 'percent' && input.value > 90) {
    throw apiError(
      'VALIDATION_FAILED',
      'Резерв больше 90% оставит витрину почти без товара — клиенты решат, что всё разобрано',
    )
  }

  try {
    return await deps.db.tx(session.tenantId, async (c) => {
      if (input.value === 0) {
        await c.query(
          `DELETE FROM branch_offline_reserve
           WHERE tenant_id = $1 AND branch_id = $2 AND category_id = $3`,
          [session.tenantId, input.branchId, input.categoryId],
        )
      } else {
        await c.query(
          `INSERT INTO branch_offline_reserve
             (tenant_id, branch_id, category_id, mode, value)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (branch_id, category_id)
           DO UPDATE SET mode = EXCLUDED.mode, value = EXCLUDED.value`,
          [session.tenantId, input.branchId, input.categoryId, input.mode, input.value],
        )
      }

      // Резерв снимает часть парка с онлайн-продажи — это решение
      // с деньгами внутри, и «кто так решил» должно быть в журнале.
      await audit(c, {
        tenantId: session.tenantId,
        staffId: session.staffId,
        action: 'offline_reserve.updated',
        targetType: 'branch',
        targetId: input.branchId,
        reason: 'настройка резерва под выдачу без связи',
        after: { categoryId: input.categoryId, mode: input.mode, value: input.value },
      })

      return { ok: true }
    })
  } catch (err) {
    throw mapDbError(err)
  }
}
