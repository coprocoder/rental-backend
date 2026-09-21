/**
 * Единицы инвентаря: список и поиск по номеру.
 *
 * ⚠️ Поиск по номеру возвращает РОВНО ОДНУ единицу — это и есть скан.
 * Поиск по позиции возвращает список. Две разные операции, и путать
 * их нельзя: «сколько ботинок 46» и «где вещь BO-0147» — разные
 * вопросы (25-учёт-без-оборудования).
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import QRCode from 'qrcode'
import { findByCode, listItems, type InventoryItem } from '~/domain/inventory/items'

/**
 * QR как SVG-строка рядом с единицей.
 *
 * ⚠️ Рисуем на СЕРВЕРЕ, а не тянем библиотеку в браузер: одна
 * реализация на печать и на экран — иначе миниатюра и наклейка
 * однажды разойдутся.
 *
 * ⚠️ Содержит ТОЛЬКО номер, никогда не ссылку с действием: метка
 * физически доступна клиенту (25-учёт-без-оборудования).
 *
 * ⚠️ В СПИСОК больше не подставляется. Рассуждение «qrcode весит
 * больше, чем готовая разметка на полсотни вещей» верно для полусотни,
 * но у реального проката 480 единиц: замер показал ответ 682 КБ,
 * из них 435 КБ (63%) — именно эти SVG. В списке они рисуются
 * миниатюрой 24×24 пикселя, где QR физически нечитаем: это
 * декоративная иконка ценой в две трети ответа. Крупный QR
 * запрашивается по номеру, когда его открывают (19.41).
 */
async function withQr(items: InventoryItem[]) {
  return Promise.all(items.map(async (i) => ({
    ...i,
    qr: await QRCode.toString(i.labelCode, {
      type: 'svg', margin: 0, errorCorrectionLevel: 'M',
    }),
  })))
}

export async function getItems(
  session: Session,
  input: Record<string, unknown>,
  deps: Deps,
) {
  const q = input
  const code = typeof q.code === 'string' ? q.code : ''
  const variantId = typeof q.variantId === 'string' ? q.variantId : undefined

  // ⚠️ Стойка и техник видят только свои филиалы: внутри тенанта нужна
  // вторая граница поверх RLS, иначе сотрудник одной точки видит склад
  // всей сети.
  const all = session.activeRole === 'owner' || session.activeRole === 'admin'
  const branchIds = all ? [] : session.branchIds

  return deps.db.tx(session.tenantId, async (c) => {
    if (code) {
      const item = await findByCode(c, { tenantId: session.tenantId, code })
      // ⚠️ Не 404: «не нашли» — это нормальный ответ скана на чужую
      // или стёртую метку, а не сбой. Экран покажет подсказку.
      const visible = item && (all || branchIds.includes(item.branchId)) ? item : null
      return { item: visible ? (await withQr([visible]))[0] : null }
    }

    // ⚠️ Категории едут вместе со списком: экран должен показать не
    // только заведённые единицы, но и то, где учёт ещё по количеству —
    // иначе включить уровень негде, и функция остаётся невидимой.
    const { rows: cats } = await c.query<{
      id: string, code: string, name: Record<string, string>,
      tracking: string, variants: number, stock: string, items: string
    }>(
      `SELECT cat.id, cat.code, cat.name, cat.tracking,
              (SELECT count(*)::int FROM inventory_variant v
                WHERE v.category_id = cat.id AND v.archived_at IS NULL) AS variants,
              COALESCE((SELECT SUM(m.qty) FROM movement m
                 JOIN inventory_variant v ON v.id = m.variant_id
                WHERE v.category_id = cat.id), 0)::text AS stock,
              (SELECT count(*) FROM item i
                 JOIN inventory_variant v ON v.id = i.variant_id
                WHERE v.category_id = cat.id AND i.archived_at IS NULL)::text AS items
         FROM category cat
        WHERE cat.tenant_id = $1 AND cat.archived_at IS NULL
          AND cat.code <> 'service'
        ORDER BY cat.sort_order, cat.code`,
      [session.tenantId],
    )

    return {
      // ⚠️ БЕЗ QR: см. комментарий к withQr. Крупный QR приходит
      // отдельным запросом по номеру — `?code=…`.
      items: await listItems(c, {
        tenantId: session.tenantId,
        variantId,
        branchIds,
        includeArchived: q.archived === '1',
      }),
      categories: cats.map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name?.ru ?? r.code,
        tracking: r.tracking,
        variants: r.variants,
        stock: Number(r.stock),
        items: Number(r.items),
      })),
    }
  })
}
