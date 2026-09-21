/**
 * Каталог для выдачи без брони (24-стойка.md).
 *
 * ⚠️ Отдельно от публичного каталога, и не «дубль ради удобства»: тот
 * работает по slug тенанта и фильтрует по сезону категории, потому что
 * витрина не должна предлагать сапборды в январе. Стойке фильтр по
 * сезону НЕ нужен: клиент уже стоит и просит конкретную вещь, а
 * смешанный заказ на стойке разрешён осознанно — запрещать его жёстко
 * значит отказать человеку, который держит доску в руках.
 *
 * ⚠️ Наличие здесь НЕ считается: на стойке оно ничего не решает
 * (железное правило №12 — расхождение не блокирует), а расчёт по дням
 * ради выпадающего списка стоил бы дороже пользы. Свободные единицы
 * покажет сама выдача.
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import { localized, type I18nField } from '~/common/utils/i18n-field'

export async function getCatalog(
  session: Session,
  input: Record<string, unknown>,
  deps: Deps,
) {
  const locale = String(input.locale ?? 'ru')
  const scoped = session.activeRole === 'counter' || session.activeRole === 'technician'

  return deps.db.tx(session.tenantId, async (c) => {
    const { rows: branches } = await c.query<{
      id: string, name: string, timezone: string
    }>(
      `SELECT id, name, timezone FROM branch
       WHERE tenant_id = $1 AND archived_at IS NULL
         AND (NOT $2 OR id = ANY($3::uuid[]))
       ORDER BY name`,
      [session.tenantId, scoped, session.branchIds],
    )

    const { rows: variants } = await c.query<{
      id: string
      code: string
      name: I18nField
      branch_id: string
      category_code: string
      category_name: I18nField
    }>(
      `SELECT iv.id, iv.code, iv.name, iv.branch_id,
              cat.code AS category_code, cat.name AS category_name
       FROM inventory_variant iv
       JOIN category cat ON cat.id = iv.category_id
       WHERE iv.tenant_id = $1 AND iv.archived_at IS NULL
         -- ⚠️ Услуги не выдаются с улицы отдельной строкой: заточка
         -- оформляется при возврате, а не как аренда (13.9).
         AND cat.code <> 'service'
         AND (NOT $2 OR iv.branch_id = ANY($3::uuid[]))
       ORDER BY cat.name, iv.sort_order, iv.code`,
      [session.tenantId, scoped, session.branchIds],
    )

    // ⚠️ Названия разворачиваются по локали здесь, а не в компоненте
    // (8.7): в браузер должна прийти строка, иначе каждая витрина
    // повторит разрешение локали по-своему и они разойдутся.
    return {
      branches,
      variants: variants.map((v) => ({
        id: v.id,
        code: v.code,
        name: localized(v.name, locale, v.code),
        branch_id: v.branch_id,
        category_code: v.category_code,
        category_name: localized(v.category_name, locale, v.category_code),
      })),
    }
  })
}
