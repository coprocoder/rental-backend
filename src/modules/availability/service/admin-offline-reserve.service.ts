/**
 * Резерв под выдачу без связи (10.10).
 *
 * ⚠️ По умолчанию НУЛЕВОЙ, и это не заглушка, а решение. Резерв — это
 * часть парка, сознательно не выставленная на сайт: она всегда доступна
 * для выдачи с улицы, но её нельзя продать онлайн. Сколько инвентаря
 * так придержать — коммерческое решение проката (доля спонтанных
 * клиентов у всех разная), и ставить его за него нельзя.
 *
 * ⚠️ Отдаются ВСЕ категории, включая ненастроенные, с нулём: иначе
 * настройка выглядит как список из одной строки, и непонятно, что
 * остальные категории тоже можно настроить.
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import { localized, type I18nField } from '~/common/utils/i18n-field'

export async function getOfflineReserve(
  session: Session,
  input: Record<string, unknown>,
  deps: Deps,
) {
  const locale = String(input.locale ?? 'ru')

  return deps.db.tx(session.tenantId, async (c) => {
    const { rows } = await c.query<Record<string, unknown>>(
      `SELECT b.id AS branch_id, b.name AS branch_name,
              cat.id AS category_id, cat.code AS category_code,
              cat.name AS category_name,
              r.mode, r.value
       FROM branch b
       CROSS JOIN category cat
       LEFT JOIN branch_offline_reserve r
              ON r.branch_id = b.id AND r.category_id = cat.id
       WHERE b.tenant_id = $1 AND b.archived_at IS NULL
         AND cat.tenant_id = $1 AND cat.archived_at IS NULL
         AND cat.code <> 'service'
       ORDER BY b.name, cat.sort_order, cat.code`,
      [session.tenantId],
    )

    return {
      rows: rows.map((r) => ({
        branchId: r.branch_id as string,
        branchName: r.branch_name as string,
        categoryId: r.category_id as string,
        categoryName: localized(r.category_name as I18nField, locale, r.category_code as string),
        mode: (r.mode as string) ?? 'percent',
        value: (r.value as number) ?? 0,
      })),
    }
  })
}
