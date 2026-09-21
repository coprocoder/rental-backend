/**
 * Свободные вещи позиции — для выбора при выдаче.
 *
 * ⚠️ Отдельный эндпоинт стойки, а не admin/items: тот требует
 * inventory.manage и функцию тарифа, а сотруднику стойки нужно лишь
 * выдать заказ. Право на управление складом для этого не нужно.
 *
 * ⚠️ «Свободна» здесь строже, чем в инвентаре: не выдана, не в
 * обслуживании, не списана И не отключена на даты аренды. Показать
 * вещь, которую нельзя выдать, значит заставить сотрудника выяснять
 * это методом тыка при клиенте.
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import { apiError } from '~/kernel/errors'
import { entitlementsFor, hasFeature } from '~/domain/core/entitlements'

export async function getFreeItems(
  session: Session,
  input: Record<string, unknown>,
  deps: Deps,
) {
  const q = input
  const variantId = String(q.variantId ?? '')
  if (!variantId) throw apiError('VALIDATION_FAILED', 'Нужна позиция')

  return deps.db.tx(session.tenantId, async (c) => {
    // ⚠️ Режим приходит отдельным полем, а не выводится из длины
    // списка: пустой список может значить и «учёт по количеству»,
    // и «все вещи на руках» — это разные ситуации.
    const { rows: mode } = await c.query<{ tracking: string }>(
      `SELECT cat.tracking FROM inventory_variant v
         JOIN category cat ON cat.id = v.category_id
        WHERE v.id = $1 AND v.tenant_id = $2`,
      [variantId, session.tenantId],
    )
    // ⚠️ И тариф тоже: категория может остаться в labeled после
    // понижения тарифа (понижение ничего не удаляет), но требовать
    // скан у проката, который за эту функцию не платит, нельзя —
    // стойка встанет на функции, которой у неё нет.
    const e = await entitlementsFor(c, session.tenantId)
    const labeled = mode[0]?.tracking === 'labeled'
      && hasFeature(e, 'labeledInventory')

    const { rows } = await c.query<{ id: string, label_code: string }>(
      `SELECT i.id, i.label_code
         FROM item i
        WHERE i.tenant_id = $1
          AND i.variant_id = $2
          AND i.archived_at IS NULL
          -- Не на руках у другого клиента.
          AND NOT EXISTS (
            SELECT 1 FROM order_line ol
             WHERE ol.item_id = i.id AND ol.status = 'picked_up'
          )
          -- Не в обслуживании: to_service отрицательное, from_service
          -- положительное, значит «в сервисе» — это минус их сумма.
          AND COALESCE((
            SELECT -SUM(m.qty) FROM movement m
             WHERE m.item_id = i.id AND m.kind IN ('to_service', 'from_service')
          ), 0) <= 0
          -- Не отключена на сегодня.
          AND NOT EXISTS (
            SELECT 1 FROM item_blackout ib
             WHERE ib.item_id = i.id AND ib.days @> current_date
          )
        ORDER BY i.label_code`,
      [session.tenantId, variantId],
    )

    return {
      labeled,
      items: labeled ? rows.map((r) => ({ id: r.id, labelCode: r.label_code })) : [],
    }
  })
}
