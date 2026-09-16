/**
 * Чтение настроек проката: тема, сотрудники, филиалы, расписание, тариф.
 *
 * ⚠️ Возвращаются СЫРЫЕ строки. Форма ответа — дело сервиса: здесь
 * только то, что пришло из БД.
 */
import type { PoolClient } from 'pg'

export interface TenantThemeRow {
  theme: Record<string, unknown> | null
  name: string
}

export async function tenantTheme(c: PoolClient, tenantId: string): Promise<TenantThemeRow | undefined> {
  const { rows } = await c.query<TenantThemeRow>(
    `SELECT theme, name FROM tenant WHERE id = $1`,
    [tenantId],
  )
  return rows[0]
}

export async function staffRows(c: PoolClient, tenantId: string): Promise<Record<string, unknown>[]> {
  const { rows } = await c.query<Record<string, unknown>>(
    `SELECT s.id, s.email, s.name, s.role, s.branch_ids,
            s.pin_hash IS NOT NULL AS has_pin,
            s.locked_at, s.locked_reason, s.created_at
     FROM staff s
     WHERE s.tenant_id = $1 AND s.archived_at IS NULL
     ORDER BY s.role, s.name`,
    [tenantId],
  )
  return rows
}

export async function branchRows(c: PoolClient, tenantId: string): Promise<Record<string, unknown>[]> {
  const { rows } = await c.query<Record<string, unknown>>(
    `SELECT id, name, address, timezone,
            season_from_month, season_to_month, created_at
     FROM branch
     WHERE tenant_id = $1 AND archived_at IS NULL
     ORDER BY name`,
    [tenantId],
  )
  return rows
}

export async function scheduleRows(c: PoolClient, tenantId: string): Promise<Record<string, unknown>[]> {
  const { rows } = await c.query<Record<string, unknown>>(
    `SELECT branch_id, weekday, exception_date::text, opens_at, closes_at, is_closed
     FROM schedule WHERE tenant_id = $1
     ORDER BY branch_id, exception_date NULLS FIRST, weekday`,
    [tenantId],
  )
  return rows
}

export interface PlanUsageRow {
  paid_until: Date | null
  plan_id: string | null
  plan_code: string | null
  plan_name: string | null
  limits: Record<string, unknown> | null
  branches: number
  variants: number
  orders_this_month: number
}

export async function planUsage(c: PoolClient, tenantId: string): Promise<PlanUsageRow | undefined> {
  const { rows } = await c.query<PlanUsageRow>(
    `SELECT t.paid_until, t.plan_id,
            p.code AS plan_code, p.name AS plan_name, p.limits,
            (SELECT count(*)::int FROM branch
              WHERE tenant_id = t.id AND archived_at IS NULL) AS branches,
            (SELECT count(*)::int FROM inventory_variant
              WHERE tenant_id = t.id AND archived_at IS NULL) AS variants,
            (SELECT count(*)::int FROM rental_order
              WHERE tenant_id = t.id
                AND created_at >= date_trunc('month', now())) AS orders_this_month
     FROM tenant t
     LEFT JOIN plan p ON p.id = t.plan_id
     WHERE t.id = $1`,
    [tenantId],
  )
  return rows[0]
}

export interface PlanRow {
  code: string
  name: string
  limits: Record<string, unknown>
  price: string | null
}

/** Все тарифы — чтобы экран показал отличия, а не только текущий. */
export async function allPlans(c: PoolClient): Promise<PlanRow[]> {
  const { rows } = await c.query<PlanRow>(
    `SELECT code, name, limits, price_per_month::text AS price
     FROM plan WHERE is_active ORDER BY price_per_month NULLS FIRST`,
  )
  return rows
}
