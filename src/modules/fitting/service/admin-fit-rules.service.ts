/** Таблицы подбора тенанта с версиями (13.10). */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import { listFitTables } from '~/domain/fitting/fit-rules'
import { localized, type I18nField } from '~/common/utils/i18n-field'

export async function getFitRules(
  session: Session,
  input: Record<string, unknown>,
  deps: Deps,
) {
  const locale = String(input.locale ?? 'ru')

  return deps.db.tx(session.tenantId, async (c) => {
    const tables = await listFitTables(c, session.tenantId)

    // Категории отдаются все: чтобы завести таблицу там, где её ещё нет.
    const { rows: cats } = await c.query<Record<string, unknown>>(
      `SELECT id, code, name FROM category
       WHERE tenant_id = $1 AND archived_at IS NULL AND code <> 'service'
       ORDER BY sort_order, code`,
      [session.tenantId],
    )

    return {
      tables: tables.map((t) => ({
        ...t,
        categoryName: localized(t.categoryName as I18nField, locale, t.categoryCode),
      })),
      categories: cats.map((c2) => ({
        id: c2.id as string,
        code: c2.code as string,
        name: localized(c2.name as I18nField, locale, c2.code as string),
      })),
    }
  })
}
