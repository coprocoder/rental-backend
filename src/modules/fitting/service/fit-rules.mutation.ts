/**
 * Новая версия таблицы подбора (13.10).
 *
 * ⚠️ Версия ЧАРТОВ обязательна и пишется вместе с таблицей: ASTM
 * отменил поправочные коэффициенты, и расчёт по старым правилам со
 * временем становится неверным. Без года невозможно понять, по каким
 * правилам считали прошлый сезон.
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import * as v from 'valibot'
import { apiError, mapDbError } from '~/kernel/errors'
import { publishFitTable } from '~/domain/fitting/fit-rules'

export const FitRulesBody = v.object({
  categoryId: v.pipe(v.string(), v.uuid()),
  // Год чартов: раньше 2000 быть не может, будущее дальше следующего
  // года — почти наверняка опечатка.
  chartYear: v.pipe(v.number(), v.integer(), v.minValue(2000), v.maxValue(2100)),
  rows: v.pipe(v.array(v.object({
    param: v.picklist(['height', 'weight', 'shoeSizeEu', 'headCircumference']),
    min: v.pipe(v.number(), v.minValue(0), v.maxValue(1000)),
    max: v.pipe(v.number(), v.minValue(0), v.maxValue(1000)),
    value: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
  })), v.minLength(1), v.maxLength(500)),
})

export interface PostFitRulesRequest {
  body: unknown
}

export async function postFitRules(
  session: Session,
  req: PostFitRulesRequest,
  deps: Deps,
) {

  const parsed = v.safeParse(FitRulesBody, req.body)
  if (!parsed.success) throw apiError('VALIDATION_FAILED', 'Проверьте строки таблицы')

  try {
    return await deps.db.tx(session.tenantId, (c) => publishFitTable(c, {
      tenantId: session.tenantId,
      categoryId: parsed.output.categoryId,
      chartYear: parsed.output.chartYear,
      rows: parsed.output.rows,
      staffId: session.staffId,
    }))
  } catch (err) {
    throw mapDbError(err)
  }
}
