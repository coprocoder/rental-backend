/**
 * Филиалы: создать, изменить, архивировать.
 *
 * ⚠️ Пояс — у филиала (сеть может пересекать зоны), сезон филиала —
 * отдельная ось от сезона категории. Лимит числа филиалов — из плана,
 * проверяется в одном месте (entitlements), а не здесь строкой.
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import * as v from 'valibot'
import { apiError, mapDbError } from '~/kernel/errors'
import { checkPlanLimit } from '~/domain/core/entitlements'
import { audit } from '~/domain/core/order-lifecycle'
import { applyProfile, cloneBranch } from '~/domain/admin/branch-clone'

const Fields = {
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  address: v.optional(v.pipe(v.string(), v.maxLength(300))),
  timezone: v.pipe(v.string(), v.minLength(3), v.maxLength(64)),
  seasonFromMonth: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(12)))),
  seasonToMonth: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(12)))),
}
const Body = v.variant('action', [
  v.object({ action: v.literal('create'), ...Fields }),
  // Клонирование и профили (17.24).
  v.object({
    action: v.literal('clone'),
    sourceBranchId: v.pipe(v.string(), v.uuid()),
    name: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
    address: v.optional(v.pipe(v.string(), v.maxLength(300))),
    timezone: v.optional(v.pipe(v.string(), v.minLength(3), v.maxLength(64))),
  }),
  v.object({
    action: v.literal('profile'),
    branchId: v.pipe(v.string(), v.uuid()),
    profile: v.picklist(['winter', 'summer']),
  }),
  v.object({ action: v.literal('update'), branchId: v.pipe(v.string(), v.uuid()), ...Fields }),
  v.object({ action: v.literal('archive'), branchId: v.pipe(v.string(), v.uuid()) }),
])

export interface PostBranchesRequest {
  body: unknown
}

export async function postBranches(
  session: Session,
  req: PostBranchesRequest,
  deps: Deps,
) {
  // Филиалы — настройка тенанта: владелец и админ.
  const parsed = v.safeParse(Body, req.body)
  if (!parsed.success) throw apiError('VALIDATION_FAILED', 'Проверьте данные филиала')
  const input = parsed.output

  if (input.action === 'clone') {
    return deps.db.tx(session.tenantId, (c) => cloneBranch(c, {
      tenantId: session.tenantId,
      sourceBranchId: input.sourceBranchId,
      name: input.name,
      address: input.address,
      timezone: input.timezone,
      staffId: session.activeStaffId,
    }))
  }

  if (input.action === 'profile') {
    return deps.db.tx(session.tenantId, (c) => applyProfile(c, {
      tenantId: session.tenantId,
      branchId: input.branchId,
      profile: input.profile,
      staffId: session.activeStaffId,
    }))
  }

  if (input.action !== 'archive') {
    try { new Intl.DateTimeFormat('en', { timeZone: input.timezone }) }
    catch { throw apiError('VALIDATION_FAILED', 'Неизвестный часовой пояс') }
  }

  try {
    return await deps.db.tx(session.tenantId, async (c) => {
      if (input.action === 'archive') {
        // ⚠️ Архив филиала с будущими бронями — оператор должен знать.
        const { rows } = await c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM rental_order
           WHERE branch_pickup_id = $1 AND status IN ('awaiting_confirm','awaiting_stock','confirmed')
             AND lower(period) > now()`, [input.branchId])
        if ((rows[0]?.n ?? 0) > 0) {
          throw apiError('INVALID_STATE', `У филиала ${rows[0]!.n} будущих броней — сначала перенесите или отмените их`)
        }
        await c.query(`UPDATE branch SET archived_at = now() WHERE id = $1 AND tenant_id = $2`,
          [input.branchId, session.tenantId])
        await audit(c, { tenantId: session.tenantId, staffId: session.activeStaffId,
          action: 'branch.archived', targetType: 'branch', targetId: input.branchId })
        return { archived: true }
      }

      if (input.action === 'create') {
        const limit = await checkPlanLimit(c, { tenantId: session.tenantId, kind: 'branches' })
        if (!limit.ok) {
          throw apiError('LIMIT_EXCEEDED', 'Достигнут лимит филиалов по тарифу',
            { current: limit.current, allowed: limit.allowed })
        }
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO branch (tenant_id, name, address, timezone, season_from_month, season_to_month)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [session.tenantId, input.name, input.address ?? null, input.timezone,
           input.seasonFromMonth ?? null, input.seasonToMonth ?? null])
        await audit(c, { tenantId: session.tenantId, staffId: session.activeStaffId,
          action: 'branch.created', targetType: 'branch', targetId: rows[0]!.id, after: input })
        return { id: rows[0]!.id }
      }

      await c.query(
        `UPDATE branch SET name = $3, address = $4, timezone = $5,
                           season_from_month = $6, season_to_month = $7
         WHERE id = $1 AND tenant_id = $2`,
        [input.branchId, session.tenantId, input.name, input.address ?? null, input.timezone,
         input.seasonFromMonth ?? null, input.seasonToMonth ?? null])
      await audit(c, { tenantId: session.tenantId, staffId: session.activeStaffId,
        action: 'branch.updated', targetType: 'branch', targetId: input.branchId, after: input })
      return { updated: true }
    })
  } catch (err) {
    throw mapDbError(err)
  }
}
