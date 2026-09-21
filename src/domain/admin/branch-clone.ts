/**
 * Клонирование филиала и стартовые профили (17.24).
 *
 * ⚠️ Зачем: второй филиал у проката почти всегда похож на первый —
 * тот же набор категорий, те же размеры, тот же прайс. Заводить его
 * заново означает час работы и гарантированные расхождения между
 * точками, которые потом всплывут в отчётах как «разные позиции».
 *
 * ⚠️ Копируются НАСТРОЙКИ, но не ОСТАТКИ. Инвентарь физически лежит
 * в конкретной точке: скопировать «40 сноубордов» во второй филиал
 * значило бы создать сорок несуществующих досок и начать их продавать.
 * Поэтому варианты создаются с нулевым остатком, а поступление
 * заводится отдельно, движением.
 *
 * ⚠️ Не копируются также заказы, клиенты и смены — они принадлежат
 * точке и истории, а не настройке.
 */
import type { PoolClient } from 'pg'
import { apiError } from '~/kernel/errors'
import { audit } from '../core/order-lifecycle'

export interface CloneResult {
  branchId: string
  variants: number
  priceRules: number
  scheduleRows: number
}

/**
 * Создаёт филиал по образцу существующего.
 *
 * ⚠️ Всё в ОДНОЙ транзакции вызывающего: филиал с половиной категорий
 * и без прайса хуже, чем отсутствие филиала — он выглядит рабочим
 * и принимает заказы, которые не посчитаются.
 */
export async function cloneBranch(
  c: PoolClient,
  opts: {
    tenantId: string
    sourceBranchId: string
    name: string
    address?: string
    /** По умолчанию — пояс образца: филиалы обычно в одном городе. */
    timezone?: string
    staffId: string
  },
): Promise<CloneResult> {
  const { rows: src } = await c.query<{ timezone: string, name: string }>(
    `SELECT timezone, name FROM branch
     WHERE id = $1 AND tenant_id = $2 AND archived_at IS NULL`,
    [opts.sourceBranchId, opts.tenantId],
  )
  if (!src[0]) throw apiError('NOT_FOUND', 'Филиал-образец не найден')

  const { rows: created } = await c.query<{ id: string }>(
    `INSERT INTO branch (tenant_id, name, address, timezone,
                         season_from_month, season_to_month)
     SELECT $1, $3, $4, COALESCE($5, b.timezone),
            b.season_from_month, b.season_to_month
     FROM branch b WHERE b.id = $2
     RETURNING id`,
    [opts.tenantId, opts.sourceBranchId, opts.name,
     opts.address ?? null, opts.timezone ?? null],
  )
  const branchId = created[0]!.id

  // ⚠️ Копируем по одному, а не одним INSERT…SELECT с хитрым
  // RETURNING. Соблазн был: связать копию с образцом подзапросом
  // в RETURNING. Так делать нельзя — Postgres выводит для одного
  // параметра два несовместимых типа (uuid и text), и запрос падает
  // на «inconsistent types deduced for parameter». Цикл на десятки
  // позиций дешевле, чем неочевидный SQL, который отвалится при
  // первой правке.
  const { rows: sources } = await c.query<{
    id: string
    category_id: string
    code: string
    name: unknown
    size_bucket: unknown
    inventory_mode: string
    sort_order: number | null
  }>(
    `SELECT id, category_id, code, name, size_bucket, inventory_mode, sort_order
     FROM inventory_variant
     WHERE tenant_id = $1 AND branch_id = $2 AND archived_at IS NULL
     ORDER BY sort_order, code`,
    [opts.tenantId, opts.sourceBranchId],
  )

  // ⚠️ Код варианта уникален в пределах тенанта, поэтому копия получает
  // суффикс филиала. Без него вставка упала бы на первом же варианте.
  const suffix = branchId.slice(0, 4)
  const variants: { id: string, src_id: string }[] = []

  for (const v of sources) {
    const { rows: ins } = await c.query<{ id: string }>(
      `INSERT INTO inventory_variant
         (tenant_id, branch_id, category_id, code, name, size_bucket,
          inventory_mode, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id, code) DO NOTHING
       RETURNING id`,
      [opts.tenantId, branchId, v.category_id, `${v.code}-${suffix}`,
       JSON.stringify(v.name), JSON.stringify(v.size_bucket),
       v.inventory_mode, v.sort_order ?? 0],
    )
    if (ins[0]) variants.push({ id: ins[0].id, src_id: v.id })
  }

  // Прайс копируется по соответствию вариантов: цена — это то, ради
  // чего клонирование и делается.
  let priceRules = 0
  for (const v of variants) {
    if (!v.src_id) continue
    const { rowCount } = await c.query(
      `INSERT INTO price_rule
         (tenant_id, variant_id, rule_kind, valid, amount, day_rates,
          percent, conditions, priority, stackable)
       SELECT $1, $2, p.rule_kind, p.valid, p.amount, p.day_rates,
              p.percent, p.conditions, p.priority, p.stackable
       FROM price_rule p
       WHERE p.tenant_id = $1 AND p.variant_id = $3
         AND p.archived_at IS NULL AND p.is_active`,
      [opts.tenantId, v.id, v.src_id],
    )
    priceRules += rowCount ?? 0
  }

  const { rowCount: scheduleRows } = await c.query(
    `INSERT INTO schedule
       (tenant_id, branch_id, weekday, exception_date, opens_at, closes_at, is_closed)
     SELECT $1, $2, s.weekday, s.exception_date, s.opens_at, s.closes_at, s.is_closed
     FROM schedule s
     WHERE s.tenant_id = $1 AND s.branch_id = $3`,
    [opts.tenantId, branchId, opts.sourceBranchId],
  )

  await audit(c, {
    tenantId: opts.tenantId,
    staffId: opts.staffId,
    action: 'branch.cloned',
    targetType: 'branch',
    targetId: branchId,
    reason: `филиал создан по образцу «${src[0].name}»`,
    after: {
      sourceBranchId: opts.sourceBranchId,
      variants: variants.length,
      priceRules,
      scheduleRows: scheduleRows ?? 0,
    },
  })

  return {
    branchId,
    variants: variants.length,
    priceRules,
    scheduleRows: scheduleRows ?? 0,
  }
}

/* ─────────────────── стартовые профили (17.24) ─────────────────── */

/**
 * Заготовки набора категорий под сезон.
 *
 * ⚠️ Профиль задаёт КАТЕГОРИИ и размерные сетки, но не количество
 * и не цену: сколько чего есть и почём — решение проката, а угаданные
 * цифры хуже пустых, потому что выглядят как настройка.
 *
 * ⚠️ Сезонность зашита в профиль: зимние категории ноябрь–апрель,
 * летние май–сентябрь. Это и есть смысл профиля — иначе прокат заведёт
 * сапборды без периода активности, и они будут предлагаться в январе.
 */
export interface ProfileCategory {
  code: string
  name: string
  seasonFromMonth: number | null
  seasonToMonth: number | null
  bodyParams: string[]
  variants: { code: string, name: string, bucket: Record<string, unknown> }[]
}

export const PROFILES: Record<string, { title: string, hint: string, categories: ProfileCategory[] }> = {
  winter: {
    title: 'Зима: горные лыжи и сноуборды',
    hint: 'Сноуборды, ботинки, шлемы, перчатки. Сезон ноябрь–апрель.',
    categories: [
      {
        code: 'snowboard',
        name: 'Сноуборд',
        seasonFromMonth: 11,
        seasonToMonth: 4,
        bodyParams: ['height', 'weight'],
        variants: [
          { code: 'sb-147', name: '147 см', bucket: { lengthMin: 145, lengthMax: 149 } },
          { code: 'sb-152', name: '152 см', bucket: { lengthMin: 150, lengthMax: 154 } },
          { code: 'sb-157', name: '157 см', bucket: { lengthMin: 155, lengthMax: 159 } },
          { code: 'sb-162', name: '162 см', bucket: { lengthMin: 160, lengthMax: 164 } },
        ],
      },
      {
        code: 'boots',
        name: 'Ботинки',
        seasonFromMonth: 11,
        seasonToMonth: 4,
        bodyParams: ['shoeSizeEu'],
        variants: [
          { code: 'bt-38', name: '38 (mondo 24.5)', bucket: { eu: 38, mondo: '24.5' } },
          { code: 'bt-40', name: '40 (mondo 25.5)', bucket: { eu: 40, mondo: '25.5' } },
          { code: 'bt-42', name: '42 (mondo 27.0)', bucket: { eu: 42, mondo: '27.0' } },
          { code: 'bt-44', name: '44 (mondo 28.5)', bucket: { eu: 44, mondo: '28.5' } },
        ],
      },
      {
        code: 'helmet',
        name: 'Шлем',
        seasonFromMonth: 11,
        seasonToMonth: 4,
        // ⚠️ Обхват головы, а НЕ рост: корреляция роста с обхватом
        // R²≈0.09–0.20, угадывание попадает меньше чем в половине
        // случаев, а неплотный шлем не держит удар.
        bodyParams: ['headCircumference'],
        variants: [
          { code: 'hl-s', name: 'S (51–55)', bucket: { min: 51, max: 55 } },
          { code: 'hl-m', name: 'M (55–59)', bucket: { min: 55, max: 59 } },
          { code: 'hl-l', name: 'L (59–62)', bucket: { min: 59, max: 62 } },
        ],
      },
      {
        code: 'gloves',
        name: 'Перчатки',
        // Перчатки нужны и летом в горах — круглый год.
        seasonFromMonth: null,
        seasonToMonth: null,
        bodyParams: [],
        variants: [
          { code: 'gl-m', name: 'M', bucket: { size: 'M' } },
          { code: 'gl-l', name: 'L', bucket: { size: 'L' } },
        ],
      },
    ],
  },
  summer: {
    title: 'Лето: сапборды',
    hint: 'Сапборды с подбором по весу. Сезон май–сентябрь.',
    categories: [
      {
        code: 'sup',
        name: 'Сапборд',
        seasonFromMonth: 5,
        seasonToMonth: 9,
        // ⚠️ Сапборд подбирается по ВЕСУ: у каждой доски свой предел.
        bodyParams: ['weight'],
        variants: [
          { code: 'sup-10', name: '10\'6" до 90 кг', bucket: { maxWeight: 90 } },
          { code: 'sup-11', name: '11\'6" до 120 кг', bucket: { maxWeight: 120 } },
        ],
      },
    ],
  },
}

/**
 * Разворачивает профиль в филиал.
 *
 * ⚠️ Идемпотентно по коду категории и варианта: повторный запуск
 * не плодит дубли, а дополняет недостающее. Прокат может сначала
 * взять зиму, потом добавить лето.
 */
export async function applyProfile(
  c: PoolClient,
  opts: { tenantId: string, branchId: string, profile: string, staffId: string },
): Promise<{ categories: number, variants: number, skipped: string[] }> {
  const profile = PROFILES[opts.profile]
  if (!profile) throw apiError('VALIDATION_FAILED', 'Неизвестный профиль')

  let categories = 0
  let variants = 0
  // ⚠️ Пропущенные коды возвращаются НАЗВАНИЯМИ, а не молча теряются.
  // Код варианта уникален в пределах тенанта, и «sup-10» во втором
  // филиале конфликтует с первым. Тихий пропуск выглядел бы как
  // «профиль применился, а позиций нет» — и разбираться пришлось бы
  // через поддержку.
  const skipped: string[] = []

  for (const [i, cat] of profile.categories.entries()) {
    const { rows: catRow } = await c.query<{ id: string }>(
      `INSERT INTO category
         (tenant_id, code, name, body_params, tracking, sort_order,
          season_from_month, season_to_month)
       VALUES ($1, $2, $3, $4, 'count', $5, $6, $7)
       ON CONFLICT (tenant_id, code) DO UPDATE SET code = excluded.code
       RETURNING id`,
      [opts.tenantId, cat.code, JSON.stringify({ ru: cat.name }),
       JSON.stringify(cat.bodyParams), i * 10,
       cat.seasonFromMonth, cat.seasonToMonth],
    )
    categories++

    for (const [vi, v] of cat.variants.entries()) {
      // ⚠️ Остаток НЕ заводится: сколько чего есть — знает прокат,
      // а выдуманное количество означало бы продажу несуществующего.
      const { rowCount } = await c.query(
        `INSERT INTO inventory_variant
           (tenant_id, branch_id, category_id, code, name, size_bucket, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, code) DO NOTHING`,
        [opts.tenantId, opts.branchId, catRow[0]!.id, v.code,
         JSON.stringify({ ru: v.name }), JSON.stringify(v.bucket), vi],
      )
      if (rowCount) variants += rowCount
      else skipped.push(v.code)
    }
  }

  await audit(c, {
    tenantId: opts.tenantId,
    staffId: opts.staffId,
    action: 'branch.profile_applied',
    targetType: 'branch',
    targetId: opts.branchId,
    reason: `применён стартовый профиль «${profile.title}»`,
    after: { profile: opts.profile, categories, variants, skipped },
  })

  return { categories, variants, skipped }
}
