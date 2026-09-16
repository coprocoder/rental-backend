/**
 * Счётчики для мастера настройки (14.3).
 *
 * ⚠️ Одним запросом, а не семью подряд: это семь независимых счётчиков,
 * и семь обращений к БД ради одного экрана дали бы семь round-trip'ов
 * там, где хватает одного. Подзапросы в SELECT — ровно тот случай, для
 * которого они существуют.
 */
import type { PoolClient } from 'pg'

/** Сколько чего заведено у тенанта. Всё — целые, БД приводит к int. */
export interface SetupCounts {
  branches: number
  variants: number
  /** Варианты, по которым был хотя бы один приход. */
  stocked: number
  priceRules: number
  scheduleRows: number
  staff: number
  orders: number
}

const EMPTY: SetupCounts = {
  branches: 0, variants: 0, stocked: 0,
  priceRules: 0, scheduleRows: 0, staff: 0, orders: 0,
}

export async function setupCounts(c: PoolClient, tenantId: string): Promise<SetupCounts> {
  const { rows } = await c.query<{
    branches: number
    variants: number
    stocked: number
    price_rules: number
    schedule_rows: number
    staff: number
    orders: number
  }>(
    `SELECT
       (SELECT count(*) FROM branch
         WHERE tenant_id = $1 AND archived_at IS NULL)::int AS branches,
       (SELECT count(*) FROM inventory_variant iv
         JOIN category cat ON cat.id = iv.category_id
         WHERE iv.tenant_id = $1 AND iv.archived_at IS NULL
           AND cat.code <> 'service')::int AS variants,
       -- ⚠️ Считаются только движения ПРИХОДА: заведённый вариант без
       -- единого поступления — это позиция, которой нет на складе,
       -- и продавать её нельзя.
       (SELECT count(DISTINCT variant_id) FROM movement
         WHERE tenant_id = $1 AND kind = 'receipt')::int AS stocked,
       (SELECT count(*) FROM price_rule
         WHERE tenant_id = $1 AND archived_at IS NULL)::int AS price_rules,
       (SELECT count(*) FROM schedule s
         JOIN branch b ON b.id = s.branch_id
         WHERE b.tenant_id = $1)::int AS schedule_rows,
       (SELECT count(*) FROM staff
         WHERE tenant_id = $1 AND archived_at IS NULL)::int AS staff,
       (SELECT count(*) FROM rental_order WHERE tenant_id = $1)::int AS orders`,
    [tenantId],
  )

  const r = rows[0]
  if (!r) return EMPTY

  // ⚠️ snake_case из БД переводится в camelCase здесь, а не на экране:
  // граница именования проходит по слою данных, иначе `price_rules`
  // расползается по коду до самого Vue-шаблона.
  return {
    branches: r.branches ?? 0,
    variants: r.variants ?? 0,
    stocked: r.stocked ?? 0,
    priceRules: r.price_rules ?? 0,
    scheduleRows: r.schedule_rows ?? 0,
    staff: r.staff ?? 0,
    orders: r.orders ?? 0,
  }
}
