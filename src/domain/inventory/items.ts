/**
 * Единицы инвентаря: номер, QR и учёт по конкретным вещам.
 *
 * Спека: ../rental-docs/docs/04-тз/10-бэкенд/25-учёт-без-оборудования.md
 *
 * ⚠️ Уровень учёта выбирается ПО КАТЕГОРИИ, а не по складу: лыжи и
 * борды можно вести поимённо, а перчатки останутся счётчиком навсегда.
 * Значение по умолчанию — `count`: прокат работает в день подключения,
 * ничего не покупая.
 *
 * ⚠️ Номера НЕ переиспользуются. Списанная вещь не освобождает свой
 * номер: наклейка существует физически в одном экземпляре, и её номер
 * не должен всплыть на другой вещи. Новая единица — новый id и новый
 * номер.
 *
 * ⚠️ «Удалить» в админке — это `archived_at`, а не DELETE. На единицу
 * ссылаются `movement` и `order_line`; физическое наличие это СУММА
 * движений, поэтому удаление вместе с движениями изменило бы остатки
 * задним числом, а без движений оставило бы висячую ссылку.
 */
import type { PoolClient } from 'pg'
import { apiError } from '~/kernel/errors'
import { localized, type I18nField } from '~/common/utils/i18n-field'

export interface ItemBlackout {
  id: string
  from: string
  to: string
  reason: string
}

export interface InventoryItem {
  id: string
  variantId: string
  variantName: string
  categoryName: string
  branchId: string
  branchName: string
  labelCode: string
  /** Чем помечена вещь: qr, barcode, nfc, rfid или ничем. */
  labelKind: string
  /** Заводской серийник — атрибут, не ключ: серийники не универсальны. */
  manufacturerSerial: string | null
  /** Описание для различения без метки: цвет, износ. */
  description: string | null
  /** Сейчас в обслуживании, выдана или свободна. */
  state: 'free' | 'issued' | 'service'
  /** Действующие и будущие отключения этой вещи. */
  blackouts: ItemBlackout[]
  archivedAt: string | null
}

/**
 * Префикс кода из кода категории.
 *
 * ⚠️ Латиница и верхний регистр: номер диктуют по телефону и вводят
 * руками в перчатках. Кириллица в коде метки — это раскладка, которую
 * сотрудник будет искать на чужом устройстве.
 */
export function codePrefix(categoryCode: string): string {
  const letters = categoryCode.replace(/[^a-zA-Z]/g, '').toUpperCase()
  return (letters.slice(0, 2) || 'IT')
}

/**
 * Следующие свободные номера для категории.
 *
 * ⚠️ Считается от МАКСИМУМА среди всех единиц тенанта с этим префиксом,
 * включая архивные: номера не переиспользуются, и счёт от количества
 * живых выдал бы номер, который уже был напечатан и наклеен.
 */
export async function nextCodes(
  c: PoolClient,
  opts: { tenantId: string, prefix: string, count: number },
): Promise<string[]> {
  const { rows } = await c.query<{ max: string | null }>(
    // Хвост после дефиса — число; берём максимум, а не количество строк.
    `SELECT MAX(NULLIF(regexp_replace(label_code, '^.*-', ''), '')::int)::text AS max
       FROM item
      WHERE tenant_id = $1 AND label_code LIKE $2 || '-%'`,
    [opts.tenantId, opts.prefix],
  )
  const start = Number(rows[0]?.max ?? 0) + 1
  return Array.from({ length: opts.count }, (_, i) =>
    `${opts.prefix}-${String(start + i).padStart(4, '0')}`)
}

/** Что сейчас с единицей: выдана, в обслуживании или свободна. */
const STATE_SQL = `
  CASE
    WHEN EXISTS (
      SELECT 1 FROM order_line ol
      WHERE ol.item_id = i.id AND ol.status = 'picked_up'
    ) THEN 'issued'
    WHEN COALESCE((
      SELECT -SUM(m.qty) FROM movement m
      WHERE m.item_id = i.id AND m.kind IN ('to_service', 'from_service')
    ), 0) > 0 THEN 'service'
    ELSE 'free'
  END`

export async function listItems(
  c: PoolClient,
  opts: {
    tenantId: string
    variantId?: string
    branchIds?: string[]
    /** Архивные скрыты по умолчанию: для сотрудника они удалены. */
    includeArchived?: boolean
    locale?: string
  },
): Promise<InventoryItem[]> {
  const scoped = (opts.branchIds?.length ?? 0) > 0
  const { rows } = await c.query<Record<string, unknown>>(
    `SELECT i.id, i.variant_id, i.label_code, i.label_kind,
            i.manufacturer_serial, i.description, i.archived_at,
            v.name AS variant_name, v.code AS variant_code,
            cat.name AS category_name, cat.code AS category_code,
            v.branch_id, b.name AS branch_name,
            ${STATE_SQL} AS state,
            -- ⚠️ Только действующие и будущие: прошедшее отключение
            -- ничего не запрещает, а в списке выглядит как запрет.
            COALESCE((
              SELECT json_agg(json_build_object(
                       'id', ib.id,
                       'from', lower(ib.days)::text,
                       'to', (upper(ib.days) - 1)::text,
                       'reason', ib.reason) ORDER BY lower(ib.days))
                FROM item_blackout ib
               WHERE ib.item_id = i.id AND upper(ib.days) > current_date
            ), '[]'::json) AS blackouts
       FROM item i
       JOIN inventory_variant v ON v.id = i.variant_id
       JOIN category cat ON cat.id = v.category_id
       JOIN branch b ON b.id = v.branch_id
      WHERE i.tenant_id = $1
        AND ($2::uuid IS NULL OR i.variant_id = $2)
        AND (NOT $3 OR v.branch_id = ANY($4::uuid[]))
        AND ($5 OR i.archived_at IS NULL)
      -- ⚠️ Сначала позиция, потом номер: «147 см» целиком, затем
      -- «152 см». Номер дополнен нулями до четырёх знаков, поэтому
      -- строковое сравнение совпадает с числовым.
      ORDER BY cat.name, v.sort_order, i.label_code`,
    [opts.tenantId, opts.variantId ?? null, scoped, opts.branchIds ?? [],
     opts.includeArchived ?? false],
  )

  const locale = opts.locale ?? 'ru'
  return rows.map((r) => ({
    id: r.id as string,
    variantId: r.variant_id as string,
    variantName: localized(r.variant_name as I18nField, locale, r.variant_code as string),
    categoryName: localized(r.category_name as I18nField, locale, r.category_code as string),
    branchId: r.branch_id as string,
    branchName: r.branch_name as string,
    labelCode: r.label_code as string,
    labelKind: r.label_kind as string,
    manufacturerSerial: (r.manufacturer_serial as string) ?? null,
    description: (r.description as string) ?? null,
    state: r.state as InventoryItem['state'],
    blackouts: (r.blackouts as ItemBlackout[]) ?? [],
    archivedAt: r.archived_at ? (r.archived_at as Date).toISOString() : null,
  }))
}

/**
 * Найти единицу по номеру — то, что делает скан.
 *
 * ⚠️ Регистр не важен: номер диктуют голосом и вводят руками. Архивные
 * НЕ находятся: для сотрудника они удалены, и «нашлась, но списана»
 * означало бы выдачу вещи, которой нет.
 */
export async function findByCode(
  c: PoolClient,
  opts: { tenantId: string, code: string, locale?: string },
): Promise<InventoryItem | null> {
  const code = opts.code.trim()
  if (!code) return null

  const { rows } = await c.query<{ id: string }>(
    `SELECT id FROM item
      WHERE tenant_id = $1 AND upper(label_code) = upper($2)
        AND archived_at IS NULL`,
    [opts.tenantId, code],
  )
  const id = rows[0]?.id
  if (!id) return null

  const all = await listItems(c, { tenantId: opts.tenantId, locale: opts.locale })
  return all.find((i) => i.id === id) ?? null
}

/**
 * Завести единицы для позиции.
 *
 * ⚠️ Коды раздаёт СИСТЕМА, а не человек: сотня наклеек с ручной
 * нумерацией — это гарантированный дубль и пропуск, а уникальность
 * номера здесь несущая конструкция.
 */
export async function createItems(
  c: PoolClient,
  opts: {
    tenantId: string
    variantId: string
    count: number
    labelKind?: 'none' | 'qr' | 'barcode' | 'nfc' | 'rfid'
    staffId: string
  },
): Promise<{ created: InventoryItem[] }> {
  if (opts.count < 1) throw apiError('VALIDATION_FAILED', 'Количество должно быть положительным')
  // ⚠️ Верхняя граница: тысяча единиц за раз почти наверняка означает
  // промах в поле, а не намерение, и печатать столько никто не станет.
  if (opts.count > 500) throw apiError('VALIDATION_FAILED', 'Больше 500 единиц за раз — проверьте число')

  const { rows: vs } = await c.query<{ category_code: string }>(
    `SELECT cat.code AS category_code
       FROM inventory_variant v
       JOIN category cat ON cat.id = v.category_id
      WHERE v.id = $1 AND v.tenant_id = $2 AND v.archived_at IS NULL`,
    [opts.variantId, opts.tenantId],
  )
  const variant = vs[0]
  if (!variant) throw apiError('NOT_FOUND', 'Позиция не найдена')

  const codes = await nextCodes(c, {
    tenantId: opts.tenantId,
    prefix: codePrefix(variant.category_code),
    count: opts.count,
  })

  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO item (tenant_id, variant_id, label_code, label_kind)
     SELECT $1, $2, code, $4::label_kind FROM unnest($3::text[]) AS code
     RETURNING id`,
    [opts.tenantId, opts.variantId, codes, opts.labelKind ?? 'qr'],
  )

  const created = await listItems(c, { tenantId: opts.tenantId, variantId: opts.variantId })
  const ids = new Set(rows.map((r) => r.id))
  return { created: created.filter((i) => ids.has(i.id)) }
}

/**
 * Скрыть единицу: вещь продали, сломали или потеряли.
 *
 * ⚠️ Не DELETE (см. шапку модуля). И не для выданной вещи: сначала
 * возврат — иначе заказ ссылается на то, чего в списках уже нет,
 * а строка заказа останется висеть в статусе «выдано».
 */
export async function archiveItem(
  c: PoolClient,
  opts: { tenantId: string, itemId: string, staffId: string },
): Promise<{ labelCode: string }> {
  const { rows } = await c.query<{ label_code: string, state: string }>(
    `SELECT i.label_code, ${STATE_SQL} AS state
       FROM item i WHERE i.id = $1 AND i.tenant_id = $2 AND i.archived_at IS NULL`,
    [opts.itemId, opts.tenantId],
  )
  const item = rows[0]
  if (!item) throw apiError('NOT_FOUND', 'Единица не найдена')
  if (item.state === 'issued') {
    throw apiError('INVALID_STATE', 'Единица сейчас выдана: сначала оформите возврат')
  }

  await c.query(`UPDATE item SET archived_at = now() WHERE id = $1`, [opts.itemId])
  return { labelCode: item.label_code }
}

/**
 * Перевести категорию на поимённый учёт и завести единицы из остатка.
 *
 * ⚠️ Без этого шага включение уровня ОБНУЛИЛО БЫ склад: наличие при
 * `labeled` считается по единицам, а их ещё нет. Поэтому переключение
 * и заведение — одна операция, а не два действия сотрудника.
 *
 * ⚠️ Обратный перевод существует, но единицы не удаляет: вернуть
 * категорию на счётчик можно, а выбросить историю вещей — нет.
 */
export async function setCategoryTracking(
  c: PoolClient,
  opts: {
    tenantId: string
    categoryId: string
    tracking: 'count' | 'labeled'
    staffId: string
  },
): Promise<{ tracking: string, itemsCreated: number }> {
  const { rows: cats } = await c.query<{ code: string, tracking: string }>(
    `SELECT code, tracking FROM category
      WHERE id = $1 AND tenant_id = $2 AND archived_at IS NULL`,
    [opts.categoryId, opts.tenantId],
  )
  const cat = cats[0]
  if (!cat) throw apiError('NOT_FOUND', 'Категория не найдена')

  await c.query(
    `UPDATE category SET tracking = $3::tracking_mode WHERE id = $1 AND tenant_id = $2`,
    [opts.categoryId, opts.tenantId, opts.tracking],
  )

  if (opts.tracking !== 'labeled') return { tracking: opts.tracking, itemsCreated: 0 }

  // Остаток по журналу минус уже заведённые единицы — столько и не хватает.
  const { rows: variants } = await c.query<{ id: string, missing: string }>(
    `SELECT v.id,
            GREATEST(
              COALESCE((SELECT SUM(m.qty) FROM movement m
                         WHERE m.variant_id = v.id AND m.branch_id = v.branch_id), 0)
              - (SELECT count(*) FROM item i
                  WHERE i.variant_id = v.id AND i.archived_at IS NULL),
              0)::text AS missing
       FROM inventory_variant v
      WHERE v.tenant_id = $1 AND v.category_id = $2 AND v.archived_at IS NULL`,
    [opts.tenantId, opts.categoryId],
  )

  let itemsCreated = 0
  for (const v of variants) {
    const missing = Number(v.missing)
    if (missing < 1) continue
    const { created } = await createItems(c, {
      tenantId: opts.tenantId,
      variantId: v.id,
      count: missing,
      staffId: opts.staffId,
    })
    itemsCreated += created.length
  }

  return { tracking: opts.tracking, itemsCreated }
}

/**
 * Отключить выбранные единицы на даты.
 *
 * ⚠️ Отключается КАЖДАЯ выбранная вещь по отдельности, а не позиция
 * целиком: в этом весь смысл поимённого учёта. Отключив позицию, мы
 * сняли бы с продажи все девять пар ботинок 44 из-за одной сломанной.
 *
 * ⚠️ Список приходит ЯВНО, а не пересчитывается по фильтру: между
 * показом и подтверждением данные могли измениться, и «применить
 * ко всем найденным» затронуло бы то, чего сотрудник не видел.
 */
export async function blackoutItems(
  c: PoolClient,
  opts: {
    tenantId: string
    itemIds: string[]
    from: string
    to: string
    reason: string
    staffId: string
  },
): Promise<{ affected: number }> {
  if (!opts.itemIds.length) throw apiError('VALIDATION_FAILED', 'Не выбрано ни одной единицы')
  if (opts.to < opts.from) throw apiError('VALIDATION_FAILED', 'Конец диапазона раньше начала')
  if (!opts.reason.trim()) throw apiError('VALIDATION_FAILED', 'Нужна причина отключения')

  const { rowCount } = await c.query(
    `INSERT INTO item_blackout (tenant_id, item_id, days, reason, created_by)
     SELECT $1, i.id, daterange($3::date, ($4::date + 1), '[)'), $5, $6
       FROM item i
      WHERE i.tenant_id = $1 AND i.id = ANY($2::uuid[]) AND i.archived_at IS NULL`,
    [opts.tenantId, opts.itemIds, opts.from, opts.to, opts.reason.trim(), opts.staffId],
  )
  return { affected: rowCount ?? 0 }
}

/**
 * Снять отключение с вещи.
 *
 * ⚠️ Запись удаляется ЦЕЛИКОМ, а не режется по датам — так же, как
 * у позиции: отключение это решение человека с причиной, и половина
 * чужого решения в базе хуже, чем его отсутствие.
 */
export async function clearItemBlackout(
  c: PoolClient,
  opts: { tenantId: string, blackoutId: string },
): Promise<{ cleared: number }> {
  const { rowCount } = await c.query(
    `DELETE FROM item_blackout WHERE tenant_id = $1 AND id = $2`,
    [opts.tenantId, opts.blackoutId],
  )
  return { cleared: rowCount ?? 0 }
}

/**
 * Скрыть несколько единиц разом.
 *
 * ⚠️ Выданные пропускаются, а не роняют операцию: сотрудник выбрал
 * десять вещей галочками, одна из них на руках — отменять остальные
 * девять из-за неё значит заставить его выбирать заново.
 */
export async function archiveItems(
  c: PoolClient,
  opts: { tenantId: string, itemIds: string[], staffId: string },
): Promise<{ archived: string[], skipped: string[] }> {
  if (!opts.itemIds.length) throw apiError('VALIDATION_FAILED', 'Не выбрано ни одной единицы')

  const archived: string[] = []
  const skipped: string[] = []
  for (const itemId of opts.itemIds) {
    try {
      const r = await archiveItem(c, { tenantId: opts.tenantId, itemId, staffId: opts.staffId })
      archived.push(r.labelCode)
    } catch {
      const { rows } = await c.query<{ label_code: string }>(
        `SELECT label_code FROM item WHERE id = $1 AND tenant_id = $2`,
        [itemId, opts.tenantId],
      )
      if (rows[0]) skipped.push(rows[0].label_code)
    }
  }
  return { archived, skipped }
}
