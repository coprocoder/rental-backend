/**
 * Демо-данные тенанта: создать и удалить.
 *
 * Зачем (docs/TODO.md 14.2): новый прокат должен увидеть работающую
 * форму до того, как заведёт свой инвентарь — иначе онбординг
 * упирается в пустой каталог. А когда свой каталог заведён, демо
 * должно уйти одной кнопкой, не оставив следов в отчётах.
 *
 * ⚠️ Демо-варианты помечены attrs.demo = true. Удаление — только по
 * метке И только если на вариант нет ни одной строки заказа: если
 * прокат успел оформить реальную бронь на демо-позицию, она уже не
 * демо, и сносить её нельзя.
 *
 * Данные — те же, что в scripts/seed.ts для тенанта demo.
 */
import type { PoolClient } from 'pg'

export const DEMO_CATEGORIES = [
  { code: 'snowboard', name: { ru: 'Сноуборд', en: 'Snowboard' }, bodyParams: ['height', 'weight'], season: [11, 4] as [number, number] | null, price: 900,
    variants: [
      { code: 'sb-147', name: { ru: '147 см' }, bucket: { lengthMin: 145, lengthMax: 149 }, qty: 3 },
      { code: 'sb-152', name: { ru: '152 см' }, bucket: { lengthMin: 150, lengthMax: 154 }, qty: 5 },
      { code: 'sb-157', name: { ru: '157 см' }, bucket: { lengthMin: 155, lengthMax: 159 }, qty: 6 },
      { code: 'sb-162', name: { ru: '162 см' }, bucket: { lengthMin: 160, lengthMax: 164 }, qty: 4 },
    ] },
  { code: 'boots', name: { ru: 'Ботинки', en: 'Boots' }, bodyParams: ['shoeSizeEu'], season: [11, 4] as [number, number] | null, price: 500,
    variants: [
      { code: 'bt-38', name: { ru: '38 (mondo 24.5)' }, bucket: { eu: 38, mondo: '24.5' }, qty: 2 },
      { code: 'bt-40', name: { ru: '40 (mondo 25.5)' }, bucket: { eu: 40, mondo: '25.5' }, qty: 4 },
      { code: 'bt-42', name: { ru: '42 (mondo 27.0)' }, bucket: { eu: 42, mondo: '27.0' }, qty: 5 },
      { code: 'bt-44', name: { ru: '44 (mondo 28.5)' }, bucket: { eu: 44, mondo: '28.5' }, qty: 3 },
    ] },
  { code: 'helmet', name: { ru: 'Шлем', en: 'Helmet' }, bodyParams: ['headCircumference'], season: [11, 4] as [number, number] | null, price: 300,
    variants: [
      { code: 'hl-s', name: { ru: 'S (51–55)' }, bucket: { min: 51, max: 55 }, qty: 4 },
      { code: 'hl-m', name: { ru: 'M (55–59)' }, bucket: { min: 55, max: 59 }, qty: 7 },
      { code: 'hl-l', name: { ru: 'L (59–62)' }, bucket: { min: 59, max: 62 }, qty: 4 },
    ] },
  { code: 'gloves', name: { ru: 'Перчатки', en: 'Gloves' }, bodyParams: [] as string[], season: null as [number, number] | null, price: 200,
    variants: [
      { code: 'gl-m', name: { ru: 'M' }, bucket: { size: 'M' }, qty: 8 },
      { code: 'gl-l', name: { ru: 'L' }, bucket: { size: 'L' }, qty: 6 },
    ] },
  { code: 'sup', name: { ru: 'Сапборд', en: 'SUP board' }, bodyParams: ['weight'], season: [5, 9] as [number, number] | null, price: 1200,
    variants: [
      { code: 'sup-10', name: { ru: '10\'6" до 90 кг' }, bucket: { maxWeight: 90 }, qty: 3 },
      { code: 'sup-11', name: { ru: '11\'6" до 120 кг' }, bucket: { maxWeight: 120 }, qty: 2 },
    ] },
]

/** Заводит демо-каталог. Идемпотентно по кодам. */
export async function createDemoInventory(
  c: PoolClient,
  opts: { tenantId: string, branchId: string },
): Promise<{ variants: number }> {
  let n = 0
  for (const [i, cat] of DEMO_CATEGORIES.entries()) {
    const { rows: [catRow] } = await c.query<{ id: string }>(
      `INSERT INTO category (tenant_id, code, name, body_params, tracking, sort_order,
                             season_from_month, season_to_month)
       VALUES ($1, $2, $3, $4, 'count', $5, $6, $7)
       ON CONFLICT (tenant_id, code) DO UPDATE SET name = excluded.name
       RETURNING id`,
      [opts.tenantId, cat.code, JSON.stringify(cat.name), JSON.stringify(cat.bodyParams), i,
       cat.season?.[0] ?? null, cat.season?.[1] ?? null],
    )
    for (const [vi, v] of cat.variants.entries()) {
      const { rows: [varRow] } = await c.query<{ id: string }>(
        `INSERT INTO inventory_variant
           (tenant_id, branch_id, category_id, code, name, size_bucket, sort_order, attrs)
         VALUES ($1, $2, $3, $4, $5, $6, $7, '{"demo": true}'::jsonb)
         ON CONFLICT (tenant_id, code) DO UPDATE SET name = excluded.name
         RETURNING id`,
        [opts.tenantId, opts.branchId, catRow!.id, v.code, JSON.stringify(v.name), JSON.stringify(v.bucket), vi],
      )
      const variantId = varRow!.id
      n++
      await c.query(
        `INSERT INTO movement (tenant_id, branch_id, variant_id, kind, qty, reason)
         SELECT $1, $2, $3, 'receipt', $4, 'демо-данные'
         WHERE NOT EXISTS (SELECT 1 FROM movement WHERE variant_id = $3 AND reason = 'демо-данные')`,
        [opts.tenantId, opts.branchId, variantId, v.qty],
      )
      await c.query(
        `INSERT INTO pool_day (tenant_id, variant_id, day, qty_booked, capacity)
         SELECT $1, $2, d::date, 0, $3
         FROM generate_series(current_date, current_date + 120, '1 day') AS d
         ON CONFLICT (variant_id, day) DO UPDATE SET capacity = excluded.capacity`,
        [opts.tenantId, variantId, v.qty],
      )
      await c.query(
        `INSERT INTO price_rule (tenant_id, variant_id, rule_kind, valid, amount, priority, stackable)
         SELECT $1, $2, 'base', tstzrange(current_date - 30, current_date + 365), $3, 100, false
         WHERE NOT EXISTS (SELECT 1 FROM price_rule WHERE variant_id = $2 AND rule_kind = 'base' AND is_active)`,
        [opts.tenantId, variantId, cat.price],
      )
    }
  }
  return { variants: n }
}

/**
 * Удаляет демо-данные.
 *
 * ⚠️ Варианты с заказами НЕ трогаются — они стали реальными. Возвращает
 * список того, что осталось и почему: прокат должен понимать, что
 * «удалить демо» не удалило бронь его первого клиента.
 */
export async function deleteDemoInventory(
  c: PoolClient,
  tenantId: string,
): Promise<{ removed: number, kept: { code: string, orders: number }[] }> {
  const { rows } = await c.query<{ id: string, code: string, orders: number }>(
    `SELECT v.id, v.code,
            (SELECT count(*)::int FROM order_line l WHERE l.variant_id = v.id) AS orders
     FROM inventory_variant v
     WHERE v.tenant_id = $1 AND v.attrs->>'demo' = 'true' AND v.archived_at IS NULL`,
    [tenantId],
  )
  const kept = rows.filter((r) => r.orders > 0).map((r) => ({ code: r.code, orders: r.orders }))
  const removable = rows.filter((r) => r.orders === 0).map((r) => r.id)

  if (removable.length) {
    // Порядок — по внешним ключам: сначала зависимые.
    await c.query(`DELETE FROM pool_day WHERE variant_id = ANY($1::uuid[])`, [removable])
    await c.query(`DELETE FROM price_rule WHERE variant_id = ANY($1::uuid[])`, [removable])
    await c.query(`DELETE FROM movement WHERE variant_id = ANY($1::uuid[])`, [removable])
    await c.query(`DELETE FROM waitlist WHERE variant_id = ANY($1::uuid[])`, [removable])
    await c.query(`DELETE FROM inventory_variant WHERE id = ANY($1::uuid[])`, [removable])
    // Категории без вариантов — архив, не удаление: на код категории
    // могут ссылаться таблицы подбора.
    await c.query(
      `UPDATE category SET archived_at = now()
       WHERE tenant_id = $1 AND archived_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM inventory_variant v WHERE v.category_id = category.id AND v.archived_at IS NULL)`,
      [tenantId],
    )
  }
  return { removed: removable.length, kept }
}
