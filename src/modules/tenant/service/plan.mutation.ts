/**
 * Смена тарифа.
 *
 * ⚠️ Это ДЕМОНСТРАЦИОННОЕ переключение, а не биллинг: состав тарифов
 * ещё будет пересобран с заказчиком, а увидеть отличия надо сейчас.
 * Настоящая смена тарифа пойдёт через оплату (14.7, в v1 счета вручную),
 * и тогда этот обработчик станет её внутренней частью, а не входом.
 *
 * ⚠️ Смена тарифа НИЧЕГО не удаляет. Понижение с расширенного до
 * базового скрывает функции, но единицы инвентаря, темы и настройки
 * остаются в базе: иначе случайное переключение уничтожило бы работу
 * проката за сезон, а вернуть её было бы нечем.
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import * as v from 'valibot'
import { apiError, mapDbError } from '~/kernel/errors'
import { audit } from '~/domain/core/order-lifecycle'

export const PlanBody = v.object({
  planCode: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
})

export interface PostPlanRequest {
  body: unknown
}

export async function postPlan(
  session: Session,
  req: PostPlanRequest,
  deps: Deps,
) {
  const parsed = v.safeParse(PlanBody, req.body)
  if (!parsed.success) throw apiError('VALIDATION_FAILED', 'Укажите тариф')
  const { planCode } = parsed.output

  try {
    return await deps.db.tx(session.tenantId, async (c) => {
      const { rows } = await c.query<{ id: string, code: string, name: string }>(
        `SELECT id, code, name FROM plan WHERE code = $1 AND is_active`,
        [planCode],
      )
      const plan = rows[0]
      if (!plan) throw apiError('NOT_FOUND', 'Тариф не найден')

      const { rows: before } = await c.query<{ code: string | null }>(
        `SELECT p.code FROM tenant t
         LEFT JOIN plan p ON p.id = t.plan_id
         WHERE t.id = $1`,
        [session.tenantId],
      )

      await c.query(`UPDATE tenant SET plan_id = $2 WHERE id = $1`,
        [session.tenantId, plan.id])

      // ⚠️ Смена тарифа меняет доступ к функциям — значит это событие
      // с автором (железное правило 13), а не тихая правка настройки.
      await audit(c, {
        tenantId: session.tenantId,
        staffId: session.activeStaffId,
        action: 'plan.changed',
        targetType: 'tenant',
        targetId: session.tenantId,
        before: { planCode: before[0]?.code ?? null },
        after: { planCode: plan.code },
      })

      return { planCode: plan.code, planName: plan.name }
    })
  } catch (err) {
    throw mapDbError(err)
  }
}
