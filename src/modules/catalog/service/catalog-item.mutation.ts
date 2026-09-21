/**
 * Новая позиция прайса: вариант инвентаря или услуга плюс цена к ней.
 *
 * Спека: ../rental-docs/docs/04-тз/10-бэкенд/14-цены.md
 *
 * ⚠️ Услуга и позиция инвентаря — ОДНА сущность `inventory_variant`,
 * различает их категория. Заточка и парафин в демо-данных заведены
 * ровно так: категория `service`, обычный вариант, обычное правило
 * цены. Отдельная таблица услуг — это вторая реализация прайса,
 * второй движок скидок и второй способ попасть в строку заказа.
 *
 * ⚠️ Разница только в учёте: у услуги нет остатков, поэтому
 * `inventory_mode = 'unverified'`. Иначе она требовала бы поступления
 * на склад, а «заточка» на полке не лежит.
 *
 * ⚠️ Вариант и цена создаются в ОДНОЙ транзакции. Порознь отказ
 * на второй вставке оставил бы позицию без цены — она попала бы
 * в каталог, но не бронировалась (движок пропускает позиции без
 * действующего правила), и найти причину было бы нечем.
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import * as v from 'valibot'
import { apiError, mapDbError } from '~/kernel/errors'
import { audit } from '~/domain/core/order-lifecycle'
import { getLimits } from '~/domain/pricing/limits'

export const CatalogItemBody = v.object({
  categoryId: v.pipe(v.string(), v.uuid()),
  /** Показываемое имя. Латинский код собирается ниже сам. */
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
  amount: v.pipe(v.string(), v.regex(/^\d+(\.\d{1,2})?$/)),
  /** Филиал: у позиции он обязателен, вариант живёт в конкретной точке. */
  branchId: v.pipe(v.string(), v.uuid()),
})

/**
 * Код позиции: латиница, цифры и дефис.
 *
 * ⚠️ Из имени код собрать нельзя — оно кириллическое, а код уходит
 * в выгрузки и внешние системы. Берём префикс категории и короткий
 * случайный хвост: осмысленность кода не стоит коллизий.
 */
function makeCode(categoryCode: string): string {
  const rnd = Math.random().toString(36).slice(2, 7)
  return `${categoryCode}-${rnd}`
}

export interface PostCatalogItemRequest {
  body: unknown
}

export async function postCatalogItem(
  session: Session,
  req: PostCatalogItemRequest,
  deps: Deps,
) {
  const parsed = v.safeParse(CatalogItemBody, req.body)
  if (!parsed.success) throw apiError('VALIDATION_FAILED', 'Проверьте категорию, название и цену')
  const input = parsed.output

  try {
    return await deps.db.tx(session.tenantId, async (c) => {
      const { rows: cat } = await c.query<{ code: string }>(
        'SELECT code FROM category WHERE id = $1 AND tenant_id = $2',
        [input.categoryId, session.tenantId],
      )
      const category = cat[0]
      if (!category) throw apiError('NOT_FOUND', 'Категория не найдена')

      // Услуги остатками не считаются: у «заточки» нет склада.
      const mode = category.code === 'service' ? 'unverified' : 'tracked'

      const { rows: made } = await c.query<{ id: string }>(
        `INSERT INTO inventory_variant
           (tenant_id, branch_id, category_id, code, name, inventory_mode)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [session.tenantId, input.branchId, input.categoryId,
         makeCode(category.code), JSON.stringify({ ru: input.name }), mode],
      )
      const variantId = made[0]!.id

      /**
       * ⚠️ Календарь наличия: ОДИН день-якорь, а не горизонт.
       *
       * Наличие считается по `pool_day`, и позиции нужна известная
       * ёмкость — иначе расчёт не от чего оттолкнуться (19.34).
       * Но заполнять 90 дней вперёд не нужно: строка на конкретный
       * день заводится в момент брони, а её отсутствие означает
       * «никто не бронировал», то есть свободно всё (19.43).
       *
       * ⚠️ Якорь дальше горизонта бронирования: он обязан оставаться
       * последним днём при сортировке, иначе обычная бронь на дальнюю
       * дату перебьёт его и ёмкость поедет.
       *
       * ⚠️ Услуги пропускаем: у «заточки» нет склада, и ограничивать
       * её ёмкостью значило бы придумать несуществующий дефицит.
       */
      if (category.code !== 'service') {
        const { maxAdvanceDays } = await getLimits(c, session.tenantId)
        await c.query(
          `INSERT INTO pool_day (tenant_id, variant_id, day, qty_booked, capacity)
           VALUES ($1, $2, (current_date + $3::int)::date, 0, 0)
           ON CONFLICT (variant_id, day) DO NOTHING`,
          [session.tenantId, variantId, maxAdvanceDays + 365],
        )
      }

      // Цена — бессрочное базовое правило с текущего момента.
      await c.query(
        `INSERT INTO price_rule
           (tenant_id, variant_id, rule_kind, valid, amount, priority, stackable)
         VALUES ($1, $2, 'base',
                 tstzrange(now(), 'infinity'::timestamptz), $3, 100, false)`,
        [session.tenantId, variantId, input.amount],
      )

      await audit(c, {
        tenantId: session.tenantId,
        staffId: session.activeStaffId,
        action: 'catalog.item_created',
        targetType: 'inventory_variant',
        targetId: variantId,
        after: { name: input.name, amount: input.amount, category: category.code },
      })

      return { id: variantId }
    })
  } catch (err) {
    throw mapDbError(err)
  }
}
