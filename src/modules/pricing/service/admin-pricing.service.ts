/** Правила цен и услуги (13.9). */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import { localized, type I18nField } from '~/common/utils/i18n-field'

export async function getPricing(
  session: Session,
  input: Record<string, unknown>,
  deps: Deps,
) {
  const locale = String(input.locale ?? 'ru')

  return deps.db.tx(session.tenantId, async (c) => {
    const { rows } = await c.query<Record<string, unknown>>(
      `SELECT p.id, p.rule_kind, p.amount, p.day_rates, p.percent,
              p.priority, p.stackable, p.is_active,
              -- ⚠️ to_char с полным смещением, а не ::text. Postgres
              -- при приведении к тексту отдаёт «2026-08-03 00:00:00+00»:
              -- пробел вместо T и смещение «+00» вместо «+00:00» — ни то
              -- ни другое не разбирается new Date(), и вся страница
              -- падала на Invalid Date в Intl.DateTimeFormat.
              to_char(lower(p.valid), 'YYYY-MM-DD"T"HH24:MI:SSOF:00') AS valid_from,
              CASE WHEN upper_inf(p.valid) THEN NULL
                   ELSE to_char(upper(p.valid), 'YYYY-MM-DD"T"HH24:MI:SSOF:00') END AS valid_to,
              p.conditions, p.variant_id,
              iv.code AS variant_code, iv.name AS variant_name,
              cat.code AS category_code, cat.name AS category_name
       FROM price_rule p
       LEFT JOIN inventory_variant iv ON iv.id = p.variant_id
       LEFT JOIN category cat ON cat.id = COALESCE(p.category_id, iv.category_id)
       WHERE p.tenant_id = $1 AND p.archived_at IS NULL
       ORDER BY cat.sort_order, iv.code, p.rule_kind, p.priority DESC`,
      [session.tenantId],
    )

    const { rows: cats } = await c.query<Record<string, unknown>>(
      'SELECT id, code, name FROM category WHERE tenant_id = $1 ORDER BY sort_order, code',
      [session.tenantId],
    )
    const { rows: brs } = await c.query<Record<string, unknown>>(
      'SELECT id, name FROM branch WHERE tenant_id = $1 AND archived_at IS NULL ORDER BY name',
      [session.tenantId],
    )

    return {
      rules: rows.map((r) => ({
        id: r.id as string,
        // Нужен, чтобы завести НОВУЮ версию правила на тот же вариант:
        // цены версионируются, правка — это архив старого плюс новое.
        variantId: (r.variant_id as string) ?? null,
        ruleKind: r.rule_kind as string,
        amount: (r.amount as string) ?? null,
        dayRates: r.day_rates ?? null,
        percent: (r.percent as number) ?? null,
        priority: (r.priority as number) ?? 0,
        stackable: r.stackable as boolean,
        isActive: r.is_active as boolean,
        validFrom: (r.valid_from as string) ?? null,
        validTo: (r.valid_to as string) ?? null,
        conditions: r.conditions ?? null,
        variantCode: (r.variant_code as string) ?? null,
        variantName: r.variant_name
          ? localized(r.variant_name as I18nField, locale, r.variant_code as string)
          : null,
        categoryName: r.category_name
          ? localized(r.category_name as I18nField, locale, r.category_code as string)
          : null,
      })),
      // Справочники для формы «добавить позицию»: без них экран
      // не может предложить ни категорию, ни филиал, а вариант
      // инвентаря обязан принадлежать и той и другому.
      categories: cats.map((r) => ({
        id: r.id as string,
        code: r.code as string,
        name: localized(r.name as I18nField, locale, r.code as string),
        /** Услуги отличаются только этим: остатков у них нет. */
        isService: (r.code as string) === 'service',
      })),
      branches: brs.map((r) => ({ id: r.id as string, name: r.name as string })),
    }
  })
}
