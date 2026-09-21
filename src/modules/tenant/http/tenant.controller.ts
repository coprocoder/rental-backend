/**
 * Маршруты настроек проката.
 *
 * ⚠️ Право и тариф — ДВЕ РАЗНЫЕ проверки: «этому сотруднику можно?» и
 * «этот прокат оплатил?». Смешивать нельзя, а проверять по отдельности
 * в каждом обработчике — значит однажды забыть вторую и раздать платную
 * функцию бесплатно.
 */
import type { App } from '~/transport/types'
import type { Deps } from '~/kernel/deps'
import { SESSION_COOKIE, requirePermission, requirePlanFeature } from '~/kernel/session'
import { getBranches, getPlan, getStaff, getTheme, getToday } from '../service/tenant.service'
import * as v from 'valibot'
import { documentRoute } from '~/transport/openapi/registry'

/**
 * ⚠️ Схемы ответов описаны РЯДОМ С РОУТАМИ, а не в общем файле: иначе
 * разойдутся с обработчиком на первой же правке, и документация начнёт
 * лгать (19.42). Сверяются с настоящими ответами тестом против эталона.
 */
const ThemeResponse = v.object({
  // ⚠️ Ключи ограничены белым списком на сервере: произвольного CSS
  // от тенанта здесь быть не может.
  theme: v.record(v.string(), v.string()),
  tenantName: v.string(),
})

const StaffResponse = v.object({
  staff: v.array(v.object({
    id: v.pipe(v.string(), v.uuid()),
    email: v.string(),
    name: v.string(),
    role: v.string(),
    branch_ids: v.nullable(v.array(v.pipe(v.string(), v.uuid()))),
    has_pin: v.boolean(),
    /** Когда заблокирован после неудачных входов; null — не заблокирован. */
    locked_at: v.nullable(v.string()),
    locked_reason: v.nullable(v.string()),
    created_at: v.string(),
  })),
})

const BranchesResponse = v.object({
  branches: v.array(v.object({
    id: v.pipe(v.string(), v.uuid()),
    name: v.string(),
    address: v.nullable(v.string()),
    /** Зона IANA, не смещение: смещение меняется при переводе часов. */
    timezone: v.string(),
    // ⚠️ Период работы филиала — независимая ось от сезона категории.
    season_from_month: v.nullable(v.number()),
    season_to_month: v.nullable(v.number()),
    created_at: v.string(),
  })),
  schedule: v.array(v.object({
    branch_id: v.pipe(v.string(), v.uuid()),
    weekday: v.nullable(v.number()),
    /** Заполнено у исключения на дату, пусто у правила по дню недели. */
    exception_date: v.nullable(v.string()),
    opens_at: v.nullable(v.string()),
    closes_at: v.nullable(v.string()),
    is_closed: v.boolean(),
  })),
})

const PlanResponse = v.object({
  plans: v.array(v.object({
    code: v.string(),
    name: v.string(),
    limits: v.record(v.string(), v.unknown()),
    pricePerMonth: v.nullable(v.string()),
  })),
  planCode: v.string(),
  planName: v.string(),
  limits: v.record(v.string(), v.unknown()),
  paidUntil: v.nullable(v.string()),
  daysLeft: v.number(),
  /** Оплата просрочена, но доступ ещё есть. */
  inGrace: v.boolean(),
  /** Доступ урезан: часть функций закрыта до оплаты. */
  restricted: v.boolean(),
  usage: v.record(v.string(), v.number()),
})

const TodayResponse = v.object({
  pickupsToday: v.number(),
  returnsToday: v.number(),
  overdue: v.number(),
  deadlineSoon: v.number(),
  awaitingStock: v.number(),
  waitlistWaiting: v.number(),
  /** Уведомления, которые не удалось доставить: требуют внимания. */
  outboxDead: v.number(),
  outboxPending: v.number(),
})

documentRoute({ method: 'get', path: '/v1/admin/theme', scope: 'staff', response: ThemeResponse,
  summary: 'Тема проката: цвета и скругления для витрины и рабочих экранов' })
documentRoute({ method: 'get', path: '/v1/admin/staff', scope: 'staff', response: StaffResponse,
  summary: 'Сотрудники проката: роли, филиалы, блокировки' })
documentRoute({ method: 'get', path: '/v1/admin/branches', scope: 'staff', response: BranchesResponse,
  summary: 'Филиалы и расписание их работы' })
documentRoute({ method: 'get', path: '/v1/admin/plan', scope: 'staff', response: PlanResponse,
  summary: 'Текущий тариф, его лимиты и использование' })
documentRoute({ method: 'get', path: '/v1/admin/today', scope: 'staff', response: TodayResponse,
  summary: 'Сводка дня: выдачи, возвраты, просрочки, очередь уведомлений' })

export function registerTenantRoutes(app: App, deps: Deps): void {
  app.get('/v1/admin/theme', async (req) => {
    const s = await requirePlanFeature(deps.db, req.cookies[SESSION_COOKIE], 'staff.manage', 'branding')
    return getTheme(s, deps)
  })

  app.get('/v1/admin/staff', async (req) => {
    const s = await requirePlanFeature(deps.db, req.cookies[SESSION_COOKIE], 'staff.manage', 'advancedInventory')
    return getStaff(s, deps)
  })

  app.get('/v1/admin/branches', async (req) => {
    const s = await requirePlanFeature(deps.db, req.cookies[SESSION_COOKIE], 'inventory.manage', 'multiBranch')
    return getBranches(s, deps)
  })

  /**
   * ⚠️ Сводка дня — часть аналитики: она про выручку и состояние
   * проката целиком. Без этой проверки экран оставался открытым по
   * прямой ссылке, хотя пункт меню уже был скрыт тарифом — ровно тот
   * разрыв, из-за которого «скрыто» принимают за «закрыто».
   */
  app.get('/v1/admin/today', async (req) => {
    const s = await requirePlanFeature(deps.db, req.cookies[SESSION_COOKIE], 'reports.revenue', 'analytics')
    return getToday(s, deps)
  })

  app.get('/v1/admin/plan', async (req) => {
    const s = await requirePermission(req.cookies[SESSION_COOKIE], 'plan.manage')
    return getPlan(s, deps)
  })
}
