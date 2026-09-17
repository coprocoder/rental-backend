/**
 * Маршруты админки модуля `tenant`.
 *
 * ⚠️ Право и тариф — ДВЕ РАЗНЫЕ проверки: «этому сотруднику можно?» и
 * «этот прокат оплатил?». Проверять по отдельности в каждом обработчике
 * — значит однажды забыть вторую и раздать платную функцию бесплатно.
 */
import type { App } from '~/transport/types'
import type { Deps } from '~/kernel/deps'
import * as v from 'valibot'
import { documentRoute } from '~/transport/openapi/registry'
import { SESSION_COOKIE, requirePlanFeature, requireSession } from '~/kernel/session'
import { getTexts } from '../service/admin-texts.service'
import { getIntegrations } from '../service/admin-integrations.service'
import { getExport } from '../service/admin-export.service'
import { getReports } from '../service/admin-reports.service'
import { getLostDemand } from '../service/admin-lost-demand.service'
import { getSetup } from '../service/admin-setup.service'

/** Состояние одной интеграции. Ключ виден только хвостом. */
const IntegrationState = v.object({
  configured: v.boolean(),
  /** Последние символы ключа — чтобы узнать, тот ли он. */
  tail: v.nullable(v.string()),
  botUsername: v.nullable(v.string()),
})

const IntegrationsResponse = v.object({
  telegram: IntegrationState,
  max: IntegrationState,
  payment: v.object({ configured: v.boolean(), provider: v.string() }),
  fiscal: v.object({ configured: v.boolean(), provider: v.string() }),
})

const SetupResponse = v.object({
  steps: v.array(v.object({
    key: v.string(),
    title: v.string(),
    hint: v.string(),
    done: v.boolean(),
    count: v.number(),
    to: v.string(),
    required: v.boolean(),
  })),
  done: v.number(),
  total: v.number(),
  /** Можно ли уже принимать заказы: не все шаги обязательны. */
  canAcceptOrders: v.boolean(),
  hasOrders: v.boolean(),
})

documentRoute({ method: 'get', path: '/v1/admin/integrations', scope: 'staff',
  response: IntegrationsResponse,
  summary: 'Подключённые мессенджеры, платежи и фискализация' })
documentRoute({ method: 'get', path: '/v1/admin/setup', scope: 'staff', response: SetupResponse,
  summary: 'Мастер настройки проката: какие шаги пройдены' })

const Period = v.object({ from: v.string(), to: v.string() })

const ReportsResponse = v.object({
  period: Period,
  /** Загрузка: сколько дней позиция была занята из возможных. */
  utilization: v.array(v.object({
    variantId: v.pipe(v.string(), v.uuid()),
    code: v.string(),
    name: v.string(),
    categoryName: v.string(),
    bookedDays: v.number(),
    capacityDays: v.number(),
    utilization: v.number(),
  })),
  revenue: v.object({
    byDay: v.array(v.object({
      day: v.string(),
      orders: v.number(),
      amount: v.string(),
    })),
    totalAmount: v.string(),
    totalOrders: v.number(),
    averageCheck: v.string(),
  }),
  noShow: v.object({
    total: v.number(),
    confirmed: v.number(),
    rate: v.number(),
  }),
  popular: v.array(v.record(v.string(), v.unknown())),
  /** Что лежит без движения: кандидаты на списание. */
  deadStock: v.array(v.record(v.string(), v.unknown())),
  lostDemand: v.array(v.record(v.string(), v.unknown())),
})

const LostDemandResponse = v.object({
  period: Period,
  rows: v.array(v.object({
    variantId: v.pipe(v.string(), v.uuid()),
    variantName: v.string(),
    /** Сколько раз отказали: спрос, который не смогли обслужить. */
    refusals: v.number(),
    estimatedAmount: v.string(),
    utilization: v.number(),
  })),
  note: v.string(),
})

documentRoute({ method: 'get', path: '/v1/admin/reports', scope: 'staff', response: ReportsResponse,
  summary: 'Отчёты: загрузка, выручка, неявки, популярное и мёртвый склад' })
documentRoute({ method: 'get', path: '/v1/admin/lost-demand', scope: 'staff',
  response: LostDemandResponse,
  summary: 'Упущенный спрос: по каким позициям отказывали и на какую сумму' })

const TextsResponse = v.object({
  kinds: v.array(v.object({
    kind: v.string(),
    title: v.string(),
    hint: v.string(),
  })),
  versions: v.array(v.object({
    id: v.pipe(v.string(), v.uuid()),
    kind: v.string(),
    version: v.number(),
    body: v.string(),
    /**
     * ⚠️ Отпечаток текста: по нему видно, ту ли редакцию подписал
     * клиент. Правка создаёт новую версию, подписанные договоры
     * остаются на своей.
     */
    hash: v.string(),
    isActive: v.boolean(),
    createdAt: v.string(),
    createdBy: v.nullable(v.string()),
  })),
  /** Типовая оферта для тенантов, заведённых до версионирования. */
  fallbackOffer: v.nullable(v.string()),
})

documentRoute({ method: 'get', path: '/v1/admin/texts', scope: 'staff', response: TextsResponse,
  summary: 'Правовые тексты: договор, политика ПД, правила и их редакции' })

export function registerTenantAdminRoutes(app: App, deps: Deps): void {
  app.get('/v1/admin/texts', async (req) => {
    const s = await requirePlanFeature(deps.db, req.cookies[SESSION_COOKIE], 'staff.manage', 'branding')
    return getTexts(s, req.query as Record<string, unknown>, deps)
  })
  app.get('/v1/admin/integrations', async (req) => {
    const s = await requirePlanFeature(deps.db, req.cookies[SESSION_COOKIE], 'integrations.manage', 'apiAccess')
    return getIntegrations(s, deps)
  })
  app.get('/v1/admin/lost-demand', async (req) => {
    const s = await requirePlanFeature(deps.db, req.cookies[SESSION_COOKIE], 'reports.revenue', 'analytics')
    const q = req.query as Record<string, unknown>
    return getLostDemand(s, {
      branchId: typeof q.branchId === 'string' ? q.branchId : undefined,
      from: typeof q.from === 'string' ? q.from : undefined,
      to: typeof q.to === 'string' ? q.to : undefined,
    }, deps)
  })

  app.get('/v1/admin/reports', async (req) => {
    const s = await requirePlanFeature(deps.db, req.cookies[SESSION_COOKIE], 'reports.revenue', 'analytics')
    return getReports(s, req.query as Record<string, unknown>, deps)
  })
  app.get('/v1/admin/setup', async (req) => {
    const s = await requireSession(req.cookies[SESSION_COOKIE])
    return getSetup(s, deps)
  })

  /**
   * ⚠️ Отдаёт CSV, а не JSON: заголовки ставит контроллер — сервис о
   * существовании HTTP не знает и возвращает просто строку.
   */
  app.get('/v1/admin/export', async (httpReq, reply) => {
    const s = await requirePlanFeature(deps.db, httpReq.cookies[SESSION_COOKIE], 'reports.revenue', 'analytics')
    const q = httpReq.query as Record<string, unknown>
    const kind = String(q.kind ?? 'orders')
    reply.header('content-type', 'text/csv; charset=utf-8')
    reply.header('content-disposition', `attachment; filename="${kind}.csv"`)
    return getExport(s, { query: q }, deps)
  })
}
