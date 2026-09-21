/**
 * Сотрудники: создать, архивировать, разблокировать, сменить PIN.
 *
 * ⚠️ Архив, не удаление: удаление сотрудника осиротило бы запись
 * «кто выставил DIN» — а это след ответственности (CLAUDE.md).
 *
 * ⚠️ Разблокировка — здесь, у владельца, а не по таймеру: иначе
 * сотрудник в субботний пик окажется заперт, и прокат встанет.
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import * as v from 'valibot'
import { apiError, mapDbError } from '~/kernel/errors'
import { requireFeature } from '~/domain/core/entitlements'
import { hashPassword } from '~/domain/core/auth'
import { audit } from '~/domain/core/order-lifecycle'

export const StaffBody = v.variant('action', [
  v.object({
    action: v.literal('create'),
    email: v.pipe(v.string(), v.email()),
    name: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
    role: v.picklist(['owner', 'admin', 'counter', 'technician']),
    password: v.pipe(v.string(), v.minLength(8), v.maxLength(200)),
    pin: v.optional(v.pipe(v.string(), v.regex(/^\d{4,8}$/))),
    /** Пусто у owner/admin — все филиалы. Стойке и технику обязательно. */
    branchIds: v.optional(v.array(v.pipe(v.string(), v.uuid()))),
  }),
  v.object({ action: v.literal('archive'), staffId: v.pipe(v.string(), v.uuid()) }),
  v.object({ action: v.literal('unlock'), staffId: v.pipe(v.string(), v.uuid()) }),
  v.object({ action: v.literal('set_pin'), staffId: v.pipe(v.string(), v.uuid()),
    pin: v.pipe(v.string(), v.regex(/^\d{4,8}$/)) }),
])

export interface PostStaffRequest {
  body: unknown
}

export async function postStaff(
  session: Session,
  req: PostStaffRequest,
  deps: Deps,
) {
  const parsed = v.safeParse(StaffBody, req.body)
  if (!parsed.success) throw apiError('VALIDATION_FAILED', 'Проверьте данные сотрудника')
  const input = parsed.output

  try {
    return await deps.db.tx(session.tenantId, async (c) => {
      switch (input.action) {
        case 'create': {
          // ⚠️ Тариф ограничивает НАБОР РОЛЕЙ, а не сам экран
          // сотрудников: завести стойку можно на любом тарифе, а
          // администратора и техника — только на расширенном. Права
          // уже заведённых сотрудников при понижении тарифа не
          // меняются: отобрать доступ у работающего человека посреди
          // сезона хуже, чем недобрать за функцию.
          if (input.role === 'admin' || input.role === 'technician') {
            await requireFeature(c, session.tenantId, 'delegatedRoles')
          }
          // ⚠️ Стойка и техник без филиала увидели бы ВСЮ сеть — это
          // нарушение границы по ПД, а не удобство по умолчанию.
          if ((input.role === 'counter' || input.role === 'technician') && !input.branchIds?.length) {
            throw apiError('VALIDATION_FAILED', 'Сотруднику стойки и технику нужен хотя бы один филиал')
          }
          const { rows } = await c.query<{ id: string }>(
            `INSERT INTO staff (tenant_id, email, name, role, password_hash, pin_hash, branch_ids)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [session.tenantId, input.email.toLowerCase(), input.name, input.role,
             await hashPassword(input.password),
             input.pin ? await hashPassword(input.pin) : null,
             input.branchIds?.length ? input.branchIds : null])
          await audit(c, { tenantId: session.tenantId, staffId: session.activeStaffId,
            action: 'staff.created', targetType: 'staff', targetId: rows[0]!.id,
            after: { email: input.email, role: input.role } })
          return { id: rows[0]!.id }
        }
        case 'archive': {
          if (input.staffId === session.activeStaffId) {
            throw apiError('INVALID_STATE', 'Нельзя архивировать себя')
          }
          await c.query(`UPDATE staff SET archived_at = now() WHERE id = $1 AND tenant_id = $2`,
            [input.staffId, session.tenantId])
          // Активные сессии отзываются: уволенный не должен доработать смену.
          await c.query(`UPDATE staff_session SET revoked_at = now()
                         WHERE (staff_id = $1 OR active_staff_id = $1) AND revoked_at IS NULL`, [input.staffId])
          await audit(c, { tenantId: session.tenantId, staffId: session.activeStaffId,
            action: 'staff.archived', targetType: 'staff', targetId: input.staffId })
          return { archived: true }
        }
        case 'unlock': {
          await c.query(`UPDATE staff SET locked_at = NULL, locked_reason = NULL WHERE id = $1 AND tenant_id = $2`,
            [input.staffId, session.tenantId])
          await c.query(`DELETE FROM staff_login_attempt
                         WHERE email = (SELECT email FROM staff WHERE id = $1) AND NOT succeeded`, [input.staffId])
          await audit(c, { tenantId: session.tenantId, staffId: session.activeStaffId,
            action: 'staff.unlocked', targetType: 'staff', targetId: input.staffId })
          return { unlocked: true }
        }
        case 'set_pin': {
          await c.query(`UPDATE staff SET pin_hash = $3 WHERE id = $1 AND tenant_id = $2`,
            [input.staffId, session.tenantId, await hashPassword(input.pin)])
          return { updated: true }
        }
      }
    })
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw apiError('VALIDATION_FAILED', 'Сотрудник с таким email уже есть')
    }
    throw mapDbError(err)
  }
}
