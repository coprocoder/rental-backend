/**
 * Запись и чтение правил прайса.
 *
 * ⚠️ Границы интервалов вычисляет ВЫЗЫВАЮЩИЙ и передаёт готовыми: где
 * начинается новая цена и чем закрывается старая — это правило продукта
 * («действует по 31 декабря» включает сам 31-й), а не деталь хранения.
 * Здесь только то, как это ложится в `tstzrange`.
 *
 * ⚠️ Пересечение базовых ставок отклоняет EXCLUDE в БД (миграция 0009),
 * а не проверка в коде: проверка гонку не закрывает. Поэтому функции
 * ничего не проверяют заранее — они дают БД сказать 23P01, а перевод
 * кода в текст для сотрудника остаётся на маршруте.
 */
import type { PoolClient } from 'pg'

export interface PriceRuleRow {
  variant_id: string
  rule_kind: string
  priority: number
  stackable: boolean
  day_rates: unknown
  /** Нижняя граница периода действия, ISO. */
  lower_at: string
}

/** Действующее правило по id. `null` — нет такого или уже архивировано. */
export async function activeRule(
  c: PoolClient,
  ruleId: string,
  tenantId: string,
): Promise<PriceRuleRow | null> {
  const { rows } = await c.query<PriceRuleRow>(
    `SELECT variant_id, rule_kind, priority, stackable, day_rates,
            lower(valid) AS lower_at
       FROM price_rule
      WHERE id = $1 AND tenant_id = $2 AND archived_at IS NULL`,
    [ruleId, tenantId],
  )
  return rows[0] ?? null
}

export async function archiveRule(
  c: PoolClient,
  ruleId: string,
  tenantId: string,
): Promise<void> {
  await c.query(
    `UPDATE price_rule SET is_active = false, archived_at = now()
      WHERE id = $1 AND tenant_id = $2 AND archived_at IS NULL`,
    [ruleId, tenantId],
  )
}

/**
 * Закрывает правило моментом `at`.
 *
 * ⚠️ Верхняя граница выставляется ровно тем же моментом, с которого
 * начинается новое правило: интервалы полуоткрытые, поэтому стык
 * получается без зазора и без нахлёста.
 */
export async function closeRuleAt(
  c: PoolClient,
  ruleId: string,
  tenantId: string,
  at: string,
): Promise<void> {
  await c.query(
    `UPDATE price_rule
        SET valid = tstzrange(lower(valid), $3::timestamptz),
            is_active = false, archived_at = now()
      WHERE id = $1 AND tenant_id = $2`,
    [ruleId, tenantId, at],
  )
}

export interface NewRule {
  tenantId: string
  variantId: string
  ruleKind: string
  /** Начало действия, ISO. */
  from: string
  /**
   * Конец действия, ISO или `null` — бессрочно.
   *
   * ⚠️ `untilExclusive` означает границу КАК ЕСТЬ: вызывающий уже
   * прибавил день, если пользователь указал «по такое-то число».
   */
  untilExclusive: string | null
  amount: string | null
  dayRates: string | null
  percent: number | null
  priority: number
  stackable: boolean
}

export async function insertRule(c: PoolClient, r: NewRule): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO price_rule
       (tenant_id, variant_id, rule_kind, valid, amount, day_rates,
        percent, priority, stackable)
     VALUES ($1, $2, $3,
             tstzrange($4::timestamptz,
                       COALESCE($10::timestamptz, 'infinity'::timestamptz)),
             $5, $6, $7, $8, $9)
     RETURNING id`,
    [r.tenantId, r.variantId, r.ruleKind, r.from,
      r.amount, r.dayRates, r.percent, r.priority, r.stackable,
      r.untilExclusive],
  )
  return rows[0]!.id
}
