/**
 * Тарифные лимиты и статус подписки — в одном месте.
 *
 * ⚠️ Проверка лимитов собрана здесь, а не разбросана по обработчикам
 * (docs/TODO.md 15.5): `if (tenant.plan === 'pro')` по коду означает,
 * что добавление плана становится правкой десятка файлов, а забытая
 * проверка — бесплатным доступом к платной функции.
 *
 * ⚠️ Градация при неоплате устроена так, что НОВЫЕ брони блокируются,
 * а СУЩЕСТВУЮЩИЕ обслуживаются (14.5). Иначе неоплата подписки
 * ударила бы по клиентам проката, которые ни при чём: человек
 * приехал за снаряжением, а система говорит «доступ закрыт». Это и
 * несправедливо, и разрушает репутацию продукта сильнее, чем недобор
 * абонентской платы.
 */
import type { PoolClient } from 'pg'
import { apiError } from '~/kernel/errors'
import { PLAN_FEATURE_INFO, type PlanFeature } from '~/common/contract/plans'

export interface PlanLimits {
  /** null — без ограничения. */
  maxBranches: number | null
  maxVariants: number | null
  maxOrdersPerMonth: number | null
  /** Свой домен, снятие брендинга, API — оси тарификации из ТЗ. */
  customDomain: boolean
  removeBranding: boolean
  apiAccess: boolean
  /** SMS дороже, поэтому логично включать в старшие планы. */
  smsChannel: boolean
  /** Единицы инвентаря с номером и QR, сканирование, история вещи. */
  labeledInventory: boolean
  /** Несколько филиалов. */
  multiBranch: boolean
  /** Расписание, массовые операции, отключения, работа без связи. */
  advancedInventory: boolean
  /** Отчёты, сводка «Сегодня», выгрузки. */
  analytics: boolean
  /** Тема, тексты, таблицы подбора. */
  branding: boolean
  /** Роли администратора и техника. */
  delegatedRoles: boolean
}

/**
 * ⚠️ Тариф без описанных лимитов — это БАЗОВЫЙ тариф, а не полный
 * доступ: пустой `limits` в БД не должен открывать платные функции.
 * Значения количественных лимитов при этом щедрые — упереться в них
 * должен только реально выросший прокат.
 */
const FALLBACK: PlanLimits = {
  maxBranches: 1,
  maxVariants: 200,
  maxOrdersPerMonth: null,
  customDomain: false,
  removeBranding: false,
  apiAccess: false,
  smsChannel: false,
  labeledInventory: false,
  multiBranch: false,
  advancedInventory: false,
  analytics: false,
  branding: false,
  delegatedRoles: false,
}

export type SubscriptionState =
  /** Оплачено или идёт пробный период. */
  | 'active'
  /** Срок вышел, но идёт льготный период: всё работает. */
  | 'grace'
  /** Льготный период истёк: новые брони не создаются. */
  | 'restricted'

/**
 * Сколько дней после paid_until всё продолжает работать.
 *
 * ⚠️ Льготный период обязателен: платёж мог задержаться на стороне
 * банка, а прокат в субботний пик не должен встать из-за этого.
 */
const GRACE_DAYS = 7

export interface Entitlements {
  planCode: string
  limits: PlanLimits
  subscription: SubscriptionState
  paidUntil: Date | null
  /** Сколько дней осталось до ограничений. Отрицательное — уже вышло. */
  daysLeft: number | null
}

export async function entitlementsFor(
  c: PoolClient,
  tenantId: string,
): Promise<Entitlements> {
  const { rows } = await c.query<{
    plan_code: string | null
    limits: Partial<PlanLimits> | null
    paid_until: Date | null
  }>(
    `SELECT p.code AS plan_code, p.limits, t.paid_until
     FROM tenant t
     LEFT JOIN plan p ON p.id = t.plan_id AND p.is_active
     WHERE t.id = $1`,
    [tenantId],
  )
  const row = rows[0]
  if (!row) throw apiError('TENANT_NOT_FOUND', 'Прокат не найден')

  const limits: PlanLimits = { ...FALLBACK, ...(row.limits ?? {}) }
  const paidUntil = row.paid_until

  let subscription: SubscriptionState = 'active'
  let daysLeft: number | null = null

  if (paidUntil) {
    const msLeft = paidUntil.getTime() - Date.now()
    daysLeft = Math.ceil(msLeft / 86_400_000)
    if (msLeft < 0) {
      subscription = -daysLeft <= GRACE_DAYS ? 'grace' : 'restricted'
    }
  }

  return {
    planCode: row.plan_code ?? 'unknown',
    limits,
    subscription,
    paidUntil,
    daysLeft,
  }
}

/**
 * Можно ли создать новую бронь.
 *
 * ⚠️ Это единственное, что ограничивается при неоплате. Выдача,
 * возврат, подтверждение и отмена существующих заказов работают
 * всегда: клиенты проката не должны страдать из-за расчётов между
 * прокатом и платформой.
 */
export function assertCanCreateOrder(e: Entitlements): void {
  if (e.subscription === 'restricted') {
    throw apiError(
      'TENANT_SUSPENDED',
      'Приём новых броней приостановлен. Уже оформленные заказы обслуживаются.',
      { paidUntil: e.paidUntil?.toISOString() ?? null },
    )
  }
}

export type LimitKind = 'branches' | 'variants' | 'orders_per_month'

/**
 * Проверяет количественный лимит плана.
 *
 * ⚠️ Считается фактическое значение, а не хранимый счётчик: счётчик
 * рассинхронизируется при удалении и архивировании, и тогда тенант
 * упирается в лимит, имея свободные места.
 */
export async function checkPlanLimit(
  c: PoolClient,
  opts: { tenantId: string, kind: LimitKind, entitlements?: Entitlements },
): Promise<{ ok: boolean, current: number, allowed: number | null }> {
  const e = opts.entitlements ?? await entitlementsFor(c, opts.tenantId)

  const allowed = opts.kind === 'branches'
    ? e.limits.maxBranches
    : opts.kind === 'variants'
      ? e.limits.maxVariants
      : e.limits.maxOrdersPerMonth

  if (allowed === null) return { ok: true, current: 0, allowed: null }

  let current = 0
  if (opts.kind === 'branches') {
    const { rows } = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM branch
       WHERE tenant_id = $1 AND archived_at IS NULL`,
      [opts.tenantId],
    )
    current = rows[0]?.n ?? 0
  } else if (opts.kind === 'variants') {
    const { rows } = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM inventory_variant
       WHERE tenant_id = $1 AND archived_at IS NULL`,
      [opts.tenantId],
    )
    current = rows[0]?.n ?? 0
  } else {
    // Календарный месяц, а не 30 дней: тенант считает так же.
    const { rows } = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM rental_order
       WHERE tenant_id = $1
         AND created_at >= date_trunc('month', now())`,
      [opts.tenantId],
    )
    current = rows[0]?.n ?? 0
  }

  return { ok: current < allowed, current, allowed }
}

/** Доступна ли функция плана. */
export function hasFeature(e: Entitlements, feature: PlanFeature): boolean {
  return e.limits[feature] === true
}

/**
 * Требует функцию тарифа, иначе отказ.
 *
 * ⚠️ Проверка живёт ЗДЕСЬ, а не в обработчиках: шапка этого модуля
 * объясняет почему — `if (tenant.plan === 'pro')` по коду означает, что
 * забытая проверка становится бесплатным доступом к платной функции.
 *
 * ⚠️ Отказ отдельным кодом `PLAN_REQUIRED`, а не `FORBIDDEN`: это не
 * «вам нельзя», а «включите тариф». Сообщение должно вести к решению,
 * иначе прокат идёт в поддержку выяснять, за что его наказали.
 */
export async function requireFeature(
  c: PoolClient,
  tenantId: string,
  feature: PlanFeature,
): Promise<void> {
  const e = await entitlementsFor(c, tenantId)
  if (hasFeature(e, feature)) return
  throw apiError(
    'PLAN_REQUIRED',
    `${PLAN_FEATURE_INFO[feature].title} — функция расширенного тарифа`,
    { feature, planCode: e.planCode },
  )
}
