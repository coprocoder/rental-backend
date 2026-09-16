/**
 * Лист ожидания в админке — с параметрами ожидающих.
 *
 * ⚠️ Главная ценность не в списке контактов, а в параметрах тела:
 * «ждут 4 человека роста 175–182 на сноуборд 157» — это готовый ввод
 * для решения о закупке (../rental-docs/docs/04-тз/10-бэкенд/22-лист-ожидания.md). Поэтому
 * body_params отдаются вместе с записью, а не только телефон.
 *
 * Порядок — по времени записи, как и сама очередь: админ видит её
 * такой, какой её видит механизм. Никакой сортировки «по важности».
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import { localized, type I18nField } from '~/common/utils/i18n-field'

export async function getWaitlist(
  session: Session,
  input: Record<string, unknown>,
  deps: Deps,
) {
  // ⚠️ Локаль параметром, а не `name->>'ru'` в запросе (8.7): жёстко
  // вписанный язык не грепается как ошибка и переживает переезд
  // в другую страну незамеченным.
  const locale = String(input.locale ?? 'ru')
  const scoped = session.activeRole === 'counter' || session.activeRole === 'technician'

  return deps.db.tx(session.tenantId, async (c) => {
    const { rows } = await c.query(
      `SELECT w.id, w.status, w.created_at, w.expires_at, w.notified_at,
              lower(w.period) AS wants_from, upper(w.period) AS wants_to,
              -- ⚠️ Гибкость видна сотруднику (17.14): «взял бы любой
              -- день недели» и «нужна именно суббота» — разный дефицит,
              -- и для закупки это не одно и то же.
              lower(w.search_period) AS search_from,
              upper(w.search_period) AS search_to,
              v.code AS variant_code, v.name AS variant_name,
              cat.code AS category_code,
              cu.name AS customer_name, right(cu.phone, 4) AS phone_tail,
              cu.body_params,
              b.name AS branch_name
       FROM waitlist w
       JOIN inventory_variant v ON v.id = w.variant_id
       JOIN category cat ON cat.id = v.category_id
       JOIN customer cu ON cu.id = w.customer_id
       JOIN branch b ON b.id = w.branch_id
       WHERE w.tenant_id = $1
         AND w.status IN ('waiting', 'offered')
         AND (NOT $2 OR w.branch_id = ANY($3::uuid[]))
       ORDER BY w.created_at`,
      [session.tenantId, scoped, session.branchIds],
    )
    return {
      entries: rows.map((r) => ({
        ...r,
        variant_name: localized(r.variant_name as I18nField, locale, r.variant_code as string),
      })),
    }
  })
}
