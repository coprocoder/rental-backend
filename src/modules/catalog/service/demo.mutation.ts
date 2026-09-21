/**
 * Демо-данные: создать заново или удалить одной кнопкой.
 *
 * ⚠️ Удаление не трогает варианты с заказами и говорит об этом явно:
 * «удалить демо» не должно снести бронь первого реального клиента.
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import * as v from 'valibot'
import { apiError, mapDbError } from '~/kernel/errors'
import { createDemoInventory, deleteDemoInventory } from '~/domain/admin/demo'
import { audit } from '~/domain/core/order-lifecycle'

export const DemoBody = v.object({
  action: v.picklist(['create', 'delete']),
  branchId: v.optional(v.pipe(v.string(), v.uuid())),
})

export interface PostDemoRequest {
  body: unknown
}

export async function postDemo(
  session: Session,
  req: PostDemoRequest,
  deps: Deps,
) {
  const parsed = v.safeParse(DemoBody, req.body)
  if (!parsed.success) throw apiError('VALIDATION_FAILED', 'Проверьте запрос')

  try {
    return await deps.db.tx(session.tenantId, async (c) => {
      if (parsed.output.action === 'create') {
        const branchId = parsed.output.branchId
          ?? (await c.query<{ id: string }>(
            `SELECT id FROM branch WHERE tenant_id = $1 AND archived_at IS NULL ORDER BY created_at LIMIT 1`,
            [session.tenantId])).rows[0]?.id
        if (!branchId) throw apiError('VALIDATION_FAILED', 'Сначала заведите филиал')
        return createDemoInventory(c, { tenantId: session.tenantId, branchId })
      }
      const result = await deleteDemoInventory(c, session.tenantId)
      await audit(c, {
        tenantId: session.tenantId, staffId: session.activeStaffId,
        action: 'inventory.demo_deleted', targetType: 'tenant', targetId: session.tenantId,
        after: result,
      })
      return result
    })
  } catch (err) {
    throw mapDbError(err)
  }
}
