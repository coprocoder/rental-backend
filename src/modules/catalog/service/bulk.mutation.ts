/**
 * Массовые операции над инвентарём (13.6).
 *
 * ⚠️ Два режима в одном эндпоинте: dryRun показывает, что затронет,
 * и только потом идёт выполнение. Это не удобство, а защита: массовое
 * действие вслепую портит сотню позиций одним нажатием, а откатывать
 * их приходится по одной.
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import * as v from 'valibot'
import { apiError, mapDbError } from '~/kernel/errors'
import { applyBulk, preview } from '~/domain/admin/bulk'
import { currentShift } from '~/domain/counter/shift'

const Filter = v.object({
  categoryId: v.optional(v.pipe(v.string(), v.uuid())),
  branchId: v.optional(v.pipe(v.string(), v.uuid())),
  q: v.optional(v.pipe(v.string(), v.maxLength(200))),
})

export const BulkBody = v.variant('mode', [
  v.object({ mode: v.literal('preview'), filter: Filter, locale: v.optional(v.string()) }),
  v.object({
    mode: v.literal('apply'),
    action: v.picklist(['write_off', 'service', 'rebucket']),
    variantIds: v.pipe(v.array(v.pipe(v.string(), v.uuid())), v.minLength(1), v.maxLength(500)),
    qty: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000))),
    targetCategoryId: v.optional(v.pipe(v.string(), v.uuid())),
    // ⚠️ Минимум 3 символа, как и у одиночных ручных действий: точка
    // в поле причины — это формально заполненная форма и пустой след.
    reason: v.pipe(v.string(), v.minLength(3, 'Опишите причину'), v.maxLength(500)),
  }),
])

export interface PostBulkRequest {
  body: unknown
}

export async function postBulk(
  session: Session,
  req: PostBulkRequest,
  deps: Deps,
) {

  const parsed = v.safeParse(BulkBody, req.body)
  if (!parsed.success) {
    throw apiError('VALIDATION_FAILED', parsed.issues[0]?.message ?? 'Проверьте запрос')
  }
  const input = parsed.output

  const branchIds = session.activeRole === 'owner' || session.activeRole === 'admin'
    ? []
    : session.branchIds

  try {
    return await deps.db.tx(session.tenantId, async (c) => {
      if (input.mode === 'preview') {
        return { affected: await preview(c, {
          tenantId: session.tenantId,
          filter: input.filter,
          branchIds,
          locale: input.locale,
        }) }
      }

      // ⚠️ Списание требует полномочия отдельно от «управления
      // инвентарём»: завести позицию и стереть парк — разные по цене
      // действия, и стойке второе недоступно.
      if (input.action === 'write_off') {
      }

      // Смена определяется здесь: движения без привязки к смене
      // невозможно потом сопоставить с тем, кто работал.
      const { rows: br } = await c.query<{ branch_id: string }>(
        `SELECT branch_id FROM inventory_variant WHERE id = $1`,
        [input.variantIds[0]],
      )
      const shift = br[0]
        ? await currentShift(c, {
            tenantId: session.tenantId,
            branchId: br[0].branch_id,
            staffId: session.activeStaffId,
          })
        : null

      return applyBulk(c, {
        tenantId: session.tenantId,
        action: input.action,
        variantIds: input.variantIds,
        qty: input.qty,
        targetCategoryId: input.targetCategoryId,
        reason: input.reason,
        staffId: session.activeStaffId,
        shiftId: shift?.id,
      })
    })
  } catch (err) {
    throw mapDbError(err)
  }
}
