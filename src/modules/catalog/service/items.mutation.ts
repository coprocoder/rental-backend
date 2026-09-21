/**
 * Единицы инвентаря: завести, скрыть, перевести категорию.
 *
 * ⚠️ «Скрыть» называется удалением в интерфейсе и является
 * `archived_at` в базе: на единицу ссылаются движения и строки
 * заказов, а физическое наличие — это СУММА движений. Физическое
 * удаление изменило бы остатки задним числом.
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import * as v from 'valibot'
import { apiError, mapDbError } from '~/kernel/errors'
import {
  archiveItem, archiveItems, blackoutItems, clearItemBlackout,
  createItems, setCategoryTracking,
} from '~/domain/inventory/items'
import { audit } from '~/domain/core/order-lifecycle'

const Body = v.variant('action', [
  v.object({
    action: v.literal('create'),
    variantId: v.pipe(v.string(), v.uuid()),
    count: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(500)),
    labelKind: v.optional(v.picklist(['none', 'qr', 'barcode', 'nfc', 'rfid'])),
  }),
  v.object({
    action: v.literal('archive'),
    itemId: v.pipe(v.string(), v.uuid()),
  }),
  v.object({
    action: v.literal('tracking'),
    categoryId: v.pipe(v.string(), v.uuid()),
    tracking: v.picklist(['count', 'labeled']),
  }),
  v.object({
    action: v.literal('archive_many'),
    // ⚠️ Верхняя граница: выбор на сотни вещей почти наверняка
    // означает промах по «выбрать все», а не намерение.
    itemIds: v.pipe(v.array(v.pipe(v.string(), v.uuid())), v.minLength(1), v.maxLength(200)),
  }),
  v.object({
    action: v.literal('blackout'),
    itemIds: v.pipe(v.array(v.pipe(v.string(), v.uuid())), v.minLength(1), v.maxLength(200)),
    from: v.pipe(v.string(), v.isoDate()),
    to: v.pipe(v.string(), v.isoDate()),
    reason: v.pipe(v.string(), v.minLength(3), v.maxLength(200)),
  }),
  v.object({
    action: v.literal('clear_blackout'),
    blackoutId: v.pipe(v.string(), v.uuid()),
  }),
])

export interface PostItemsRequest {
  body: unknown
}

export async function postItems(
  session: Session,
  req: PostItemsRequest,
  deps: Deps,
) {
  const parsed = v.safeParse(Body, req.body)
  if (!parsed.success) throw apiError('VALIDATION_FAILED', 'Проверьте данные')
  const input = parsed.output

  try {
    return await deps.db.tx(session.tenantId, async (c) => {
      if (input.action === 'create') {
        const r = await createItems(c, {
          tenantId: session.tenantId,
          variantId: input.variantId,
          count: input.count,
          labelKind: input.labelKind,
          staffId: session.activeStaffId,
        })
        await audit(c, {
          tenantId: session.tenantId, staffId: session.activeStaffId,
          action: 'inventory.items_created',
          targetType: 'inventory_variant', targetId: input.variantId,
          after: { count: r.created.length, codes: r.created.map((i) => i.labelCode) },
        })
        return r
      }

      if (input.action === 'archive') {
        const r = await archiveItem(c, {
          tenantId: session.tenantId,
          itemId: input.itemId,
          staffId: session.activeStaffId,
        })
        await audit(c, {
          tenantId: session.tenantId, staffId: session.activeStaffId,
          action: 'inventory.item_archived',
          targetType: 'item', targetId: input.itemId,
          after: { labelCode: r.labelCode },
        })
        return r
      }

      if (input.action === 'archive_many') {
        const r = await archiveItems(c, {
          tenantId: session.tenantId,
          itemIds: input.itemIds,
          staffId: session.activeStaffId,
        })
        await audit(c, {
          tenantId: session.tenantId, staffId: session.activeStaffId,
          action: 'inventory.items_archived',
          targetType: 'item', targetId: input.itemIds[0]!,
          after: { archived: r.archived, skipped: r.skipped },
        })
        return r
      }

      if (input.action === 'blackout') {
        const r = await blackoutItems(c, {
          tenantId: session.tenantId,
          itemIds: input.itemIds,
          from: input.from,
          to: input.to,
          reason: input.reason,
          staffId: session.activeStaffId,
        })
        await audit(c, {
          tenantId: session.tenantId, staffId: session.activeStaffId,
          action: 'inventory.items_blackout',
          targetType: 'item', targetId: input.itemIds[0]!,
          after: { count: r.affected, from: input.from, to: input.to, reason: input.reason },
        })
        return r
      }

      if (input.action === 'clear_blackout') {
        const r = await clearItemBlackout(c, {
          tenantId: session.tenantId,
          blackoutId: input.blackoutId,
        })
        await audit(c, {
          tenantId: session.tenantId, staffId: session.activeStaffId,
          action: 'inventory.item_blackout_cleared',
          targetType: 'item_blackout', targetId: input.blackoutId,
          after: { cleared: r.cleared },
        })
        return r
      }

      const r = await setCategoryTracking(c, {
        tenantId: session.tenantId,
        categoryId: input.categoryId,
        tracking: input.tracking,
        staffId: session.activeStaffId,
      })
      // ⚠️ Смена уровня учёта меняет способ подсчёта наличия — это
      // событие с автором, а не тихая правка настройки.
      await audit(c, {
        tenantId: session.tenantId, staffId: session.activeStaffId,
        action: 'inventory.tracking_changed',
        targetType: 'category', targetId: input.categoryId,
        after: { tracking: r.tracking, itemsCreated: r.itemsCreated },
      })
      return r
    })
  } catch (err) {
    throw mapDbError(err)
  }
}
