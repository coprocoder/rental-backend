/**
 * Отчёты владельца (13.19, 17.12).
 *
 * ⚠️ Право reports.revenue: выручка — это то, что владелец не всегда
 * показывает даже администратору, и уж точно не стойке.
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import { apiError } from '~/kernel/errors'
import {
  deadStockReport,
  noShowReport,
  popularSizesReport,
  revenueReport,
  utilizationReport,
} from '~/domain/admin/reports'
import { lostDemandReport } from '~/domain/availability/demand'

/** Период по умолчанию — последние 90 дней: сезон в разгаре виден целиком. */
function defaultPeriod(): { from: string, to: string } {
  const to = new Date()
  const from = new Date(to.getTime() - 90 * 86_400_000)
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) }
}

export async function getReports(
  session: Session,
  input: Record<string, unknown>,
  deps: Deps,
) {
  const q = input

  const d = defaultPeriod()
  const from = typeof q.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(q.from) ? q.from : d.from
  const to = typeof q.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(q.to) ? q.to : d.to
  if (from > to) throw apiError('VALIDATION_FAILED', 'Начало периода позже конца')

  const branchId = typeof q.branchId === 'string' && q.branchId ? q.branchId : undefined

  return deps.db.tx(session.tenantId, async (c) => {
    const opts = { tenantId: session.tenantId, branchId, from, to }
    // Запросы независимы — идут параллельно: отчётов шесть, и
    // последовательное выполнение заметно на глаз.
    const [utilization, revenue, noShow, popular, deadStock, lostDemand] = await Promise.all([
      utilizationReport(c, opts),
      revenueReport(c, opts),
      noShowReport(c, opts),
      popularSizesReport(c, opts),
      deadStockReport(c, opts),
      lostDemandReport(c, opts),
    ])

    return { period: { from, to }, utilization, revenue, noShow, popular, deadStock, lostDemand }
  })
}
