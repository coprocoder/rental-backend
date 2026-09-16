/**
 * Отчёт об упущенном спросе: чего не хватило и сколько это стоило.
 *
 * ⚠️ Дисклеймер про оценку идёт ВМЕСТЕ с данными, а не только в
 * интерфейсе: цифру уносят в таблицу закупки, и там она должна
 * сопровождаться оговоркой.
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import { apiError } from '~/kernel/errors'
import { canAccessBranch } from '~/domain/core/auth'
import { lostDemandReport } from '~/domain/availability/demand'

export interface LostDemandInput {
  branchId?: string | undefined
  from?: string | undefined
  to?: string | undefined
}

export async function getLostDemand(
  session: Session,
  input: LostDemandInput,
  deps: Deps,
) {
  if (input.branchId && !canAccessBranch(session, input.branchId)) {
    throw apiError('FORBIDDEN', 'Этот филиал вам недоступен')
  }

  // ⚠️ Часы из deps, а не Date.now(): иначе период отчёта нельзя
  // зафиксировать в тесте, и проверка «за последние 90 дней» пишется
  // только ожиданием.
  const isoDaysAgo = (n: number) =>
    new Date(deps.clock().getTime() - n * 86_400_000).toISOString().slice(0, 10)

  const from = input.from ?? isoDaysAgo(90)
  const to = input.to ?? isoDaysAgo(0)

  const rows = await deps.db.tx(session.tenantId, (c) => lostDemandReport(c, {
    tenantId: session.tenantId,
    branchId: input.branchId,
    from,
    to,
  }))

  return {
    period: { from, to },
    rows,
    /** ⚠️ Дисклеймер идёт вместе с данными, а не только в интерфейсе. */
    note: 'Сумма — оценка по прайсу на дату отказа, а не недополученная выручка: '
      + 'часть обратившихся не оформила бы заказ и при наличии.',
  }
}

/** CSV — чтобы прокат мог унести цифры в свою таблицу закупки. */
export function lostDemandCsv(rows: Awaited<ReturnType<typeof getLostDemand>>['rows']): string {
  const head = 'variant,refusals,estimated_amount,utilization_percent'
  const body = rows.map((r) =>
    [
      `"${r.variantName.replace(/"/g, '""')}"`,
      r.refusals,
      r.estimatedAmount,
      Math.round(r.utilization * 100),
    ].join(','),
  )
  return [head, ...body].join('\n')
}
