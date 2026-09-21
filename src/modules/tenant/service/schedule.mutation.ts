/**
 * Расписание филиала: часы работы и исключения (13.11, ТЗ 18-время).
 *
 * ⚠️ Экран расписания был только на чтение: `INSERT INTO schedule`
 * существовал в сиде и при клонировании филиала, admin-эндпоинта
 * не было вовсе. То есть прокат не мог задать свои часы работы —
 * либо чужие из шаблона, либо пустое расписание, которое
 * checkBusinessHours трактует как «работает круглосуточно».
 *
 * ⚠️ Время хранится ЛОКАЛЬНОЕ для филиала, не UTC: иначе после
 * перевода часов расписание уедет на час, причём молча.
 *
 * ⚠️ Правила недели заменяются целиком, а не по одному дню:
 * частичное обновление оставило бы в базе смесь старого и нового,
 * а прокат меняет расписание сезонными наборами.
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import * as v from 'valibot'
import { apiError, mapDbError } from '~/kernel/errors'
import { canAccessBranch } from '~/domain/core/auth'
import { audit } from '~/domain/core/order-lifecycle'

const Time = v.pipe(v.string(), v.regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Время в формате ЧЧ:ММ'))
const Day = v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате ГГГГ-ММ-ДД'))

/** Один интервал: либо закрыто, либо пара «открылись — закрылись». */
const Slot = v.object({
  isClosed: v.optional(v.boolean(), false),
  opensAt: v.optional(Time),
  closesAt: v.optional(Time),
})

export const ScheduleBody = v.variant('action', [
  v.object({
    action: v.literal('week'),
    branchId: v.pipe(v.string(), v.uuid()),
    // Ровно семь дней, индекс = номер дня (0 — воскресенье).
    days: v.pipe(v.array(Slot), v.length(7)),
  }),
  v.object({
    action: v.literal('exception'),
    branchId: v.pipe(v.string(), v.uuid()),
    date: Day,
    ...Slot.entries,
  }),
  v.object({
    action: v.literal('exception_delete'),
    branchId: v.pipe(v.string(), v.uuid()),
    date: Day,
  }),
])

/**
 * ⚠️ Открытый интервал обязан иметь обе границы и не быть вывернутым.
 * Иначе `checkBusinessHours` сравнивает с null и молча пропускает
 * бронь на нерабочее время — ровно та ошибка, от которой расписание
 * и защищает.
 */
function assertSlot(s: { isClosed?: boolean, opensAt?: string, closesAt?: string }, where: string) {
  if (s.isClosed) return
  if (!s.opensAt || !s.closesAt) {
    throw apiError('VALIDATION_FAILED', `${where}: укажите часы работы или отметьте «закрыто»`)
  }
  if (s.closesAt <= s.opensAt) {
    throw apiError('VALIDATION_FAILED', `${where}: закрытие раньше открытия`)
  }
}

const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота']

export interface PostScheduleRequest {
  body: unknown
}

export async function postSchedule(
  session: Session,
  req: PostScheduleRequest,
  deps: Deps,
) {

  const parsed = v.safeParse(ScheduleBody, req.body)
  if (!parsed.success) {
    throw apiError('VALIDATION_FAILED', parsed.issues[0]?.message ?? 'Проверьте расписание')
  }
  const input = parsed.output

  if (!canAccessBranch(session, input.branchId)) {
    throw apiError('FORBIDDEN', 'Этот филиал вам недоступен')
  }

  try {
    return await deps.db.tx(session.tenantId, async (c) => {
      if (input.action === 'week') {
        input.days.forEach((d, i) => assertSlot(d, WEEKDAYS[i]!))

        // ⚠️ Только правила недели: исключения по датам живут своей
        // жизнью, и замена недели не должна стирать санитарный день.
        await c.query(
          `DELETE FROM schedule
            WHERE tenant_id = $1 AND branch_id = $2 AND exception_date IS NULL`,
          [session.tenantId, input.branchId],
        )
        for (const [weekday, d] of input.days.entries()) {
          await c.query(
            `INSERT INTO schedule
               (tenant_id, branch_id, weekday, opens_at, closes_at, is_closed)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              session.tenantId, input.branchId, weekday,
              d.isClosed ? null : d.opensAt, d.isClosed ? null : d.closesAt, d.isClosed,
            ],
          )
        }
        await audit(c, {
          tenantId: session.tenantId,
          staffId: session.activeStaffId,
          action: 'schedule.week_set',
          targetType: 'branch',
          targetId: input.branchId,
          after: { days: input.days },
        })
        return { ok: true }
      }

      if (input.action === 'exception_delete') {
        const { rowCount } = await c.query(
          `DELETE FROM schedule
            WHERE tenant_id = $1 AND branch_id = $2 AND exception_date = $3::date`,
          [session.tenantId, input.branchId, input.date],
        )
        await audit(c, {
          tenantId: session.tenantId,
          staffId: session.activeStaffId,
          action: 'schedule.exception_removed',
          targetType: 'branch',
          targetId: input.branchId,
          after: { date: input.date },
        })
        return { removed: rowCount ?? 0 }
      }

      assertSlot(input, `исключение ${input.date}`)

      // Исключение на дату одно: повторное задание заменяет прежнее.
      await c.query(
        `DELETE FROM schedule
          WHERE tenant_id = $1 AND branch_id = $2 AND exception_date = $3::date`,
        [session.tenantId, input.branchId, input.date],
      )
      await c.query(
        `INSERT INTO schedule
           (tenant_id, branch_id, exception_date, opens_at, closes_at, is_closed)
         VALUES ($1, $2, $3::date, $4, $5, $6)`,
        [
          session.tenantId, input.branchId, input.date,
          input.isClosed ? null : input.opensAt, input.isClosed ? null : input.closesAt,
          input.isClosed ?? false,
        ],
      )
      await audit(c, {
        tenantId: session.tenantId,
        staffId: session.activeStaffId,
        action: 'schedule.exception_set',
        targetType: 'branch',
        targetId: input.branchId,
        after: { date: input.date, isClosed: input.isClosed, opensAt: input.opensAt, closesAt: input.closesAt },
      })
      return { ok: true }
    })
  } catch (err) {
    throw mapDbError(err)
  }
}
