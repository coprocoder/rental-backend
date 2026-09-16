/**
 * Отключение позиции на конкретные даты (18.2).
 *
 * ⚠️ Прямая жалоба на конкурента: «невозможно полностью отключить
 * товар на определённые дни». Сезонность категории и расписание
 * филиала этого не закрывают — они про КАТЕГОРИЮ и про ФИЛИАЛ,
 * а выключить нужно один вариант на конкретные даты: сноуборд уехал
 * на выставку, ботинки в ремонте до пятницы.
 *
 * ⚠️ Домен blackout.ts был написан и покрыт тестами, но вызывался
 * ТОЛЬКО из них: ни эндпоинта, ни экрана. Пункт стоял отмеченным
 * как сделанный, а тенант воспользоваться им не мог — тот же класс
 * дефекта, что с резервом под оффлайн (20.7).
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import * as v from 'valibot'
import { apiError, mapDbError } from '~/kernel/errors'
import { blackoutVariant, clearBlackout } from '~/domain/availability/blackout'
import { audit } from '~/domain/core/order-lifecycle'

const Day = v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате ГГГГ-ММ-ДД'))

const Body = v.variant('action', [
  v.object({
    action: v.literal('set'),
    variantId: v.pipe(v.string(), v.uuid()),
    from: Day,
    to: Day,
    // ⚠️ Причина обязательна: отключение видно только по последствию
    // («почему нельзя забронировать?»), и без неё разобраться через
    // месяц невозможно даже тому, кто его поставил.
    reason: v.pipe(v.string(), v.trim(), v.minLength(3), v.maxLength(200)),
  }),
  v.object({
    action: v.literal('clear'),
    variantId: v.pipe(v.string(), v.uuid()),
    from: Day,
    to: Day,
  }),
])

export interface PostBlackoutRequest {
  body: unknown
}

export async function postBlackout(
  session: Session,
  req: PostBlackoutRequest,
  deps: Deps,
) {

  const parsed = v.safeParse(Body, req.body)
  if (!parsed.success) {
    throw apiError('VALIDATION_FAILED', parsed.issues[0]?.message ?? 'Проверьте данные отключения')
  }
  const input = parsed.output

  try {
    return await deps.db.tx(session.tenantId, async (c) => {
      if (input.action === 'clear') {
        const removed = await clearBlackout(c, {
          tenantId: session.tenantId,
          variantId: input.variantId,
          from: input.from,
          to: input.to,
        })
        await audit(c, {
          tenantId: session.tenantId,
          staffId: session.activeStaffId,
          action: 'variant.blackout_cleared',
          targetType: 'inventory_variant',
          targetId: input.variantId,
          after: { from: input.from, to: input.to, removed },
        })
        return { removed }
      }

      await blackoutVariant(c, {
        tenantId: session.tenantId,
        variantId: input.variantId,
        from: input.from,
        to: input.to,
        reason: input.reason,
        staffId: session.activeStaffId,
      })
      await audit(c, {
        tenantId: session.tenantId,
        staffId: session.activeStaffId,
        action: 'variant.blackout_set',
        targetType: 'inventory_variant',
        targetId: input.variantId,
        after: { from: input.from, to: input.to, reason: input.reason },
      })
      return { ok: true }
    })
  } catch (err) {
    throw mapDbError(err)
  }
}
