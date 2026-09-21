/**
 * Таблицы подбора как ДАННЫЕ, с версионированием (13.10, 3.12).
 *
 * ⚠️ Правила подбора обязаны быть данными, а не кодом. Обещание ТЗ
 * (../rental-docs/docs/04-тз/00-общее/03-домен.md): у каждого проката своя политика — кому-то
 * новичку дают короче, — правила меняются между сезонами, а для летнего
 * инвентаря таблицы совсем другие. Если это код, каждое изменение
 * политики становится релизом, и прокат ждёт нас, чтобы изменить
 * собственное решение.
 *
 * ⚠️ Версия ЧАРТОВ (chart_year) обязательна и пишется в заказ вместе
 * с подбором: ASTM отменил поправочные коэффициенты около трёх лет
 * назад, и расчёт по старым правилам со временем становится неверным.
 * Без версии невозможно понять, по каким правилам считали прошлый сезон.
 *
 * ⚠️ Правила ДОПОЛНЯЮТ встроенные, а не заменяют их молчанием: если
 * прокат не завёл свою таблицу, работают формулы из shared-логики
 * (domain/fitting.ts). Пустая таблица не должна означать «подбора нет» —
 * система обязана работать при небрежном заполнении данных.
 *
 * ⚠️ Правка создаёт НОВУЮ версию, старая архивируется. Причина та же,
 * что у текстов: в заказе лежит снимок подбора, и понять через сезон,
 * почему клиенту дали именно 157 см, можно только если та редакция
 * таблицы сохранилась.
 */
import type { PoolClient } from 'pg'
import { apiError } from '~/kernel/errors'
import { audit } from '../core/order-lifecycle'

/**
 * Строка таблицы подбора.
 *
 * Диапазон входного параметра → размерный бакет. Границы полуоткрытые
 * `[min, max)`, как и интервалы времени: иначе рост ровно 170 попадает
 * в две строки сразу, и какая выиграет — зависит от порядка выборки.
 */
export interface FitRow {
  /** По какому параметру: рост, вес, размер обуви, обхват головы. */
  param: 'height' | 'weight' | 'shoeSizeEu' | 'headCircumference'
  /** Включительно. */
  min: number
  /** Не включительно. */
  max: number
  /** Код варианта или значение бакета, которое получит клиент. */
  value: string
}

export interface FitTable {
  id: string
  categoryId: string
  categoryCode: string
  categoryName: unknown
  chartYear: number
  version: number
  isActive: boolean
  rows: FitRow[]
}

/** Действующие таблицы тенанта. */
export async function listFitTables(
  c: PoolClient,
  tenantId: string,
): Promise<FitTable[]> {
  const { rows } = await c.query<Record<string, unknown>>(
    `SELECT f.id, f.category_id, f.chart_year, f.version, f.is_active, f.rule,
            cat.code AS category_code, cat.name AS category_name
     FROM fit_rule f
     JOIN category cat ON cat.id = f.category_id
     WHERE f.tenant_id = $1 AND f.archived_at IS NULL
     ORDER BY cat.sort_order, cat.code, f.version DESC`,
    [tenantId],
  )

  return rows.map((r) => ({
    id: r.id as string,
    categoryId: r.category_id as string,
    categoryCode: r.category_code as string,
    categoryName: r.category_name,
    chartYear: r.chart_year as number,
    version: r.version as number,
    isActive: r.is_active as boolean,
    rows: normalizeRows(r.rule),
  }))
}

/**
 * Разбирает jsonb правила в строки таблицы.
 *
 * ⚠️ Молча пропускает нераспознанное, а НЕ падает: правило могло быть
 * записано более старой версией системы, и уронить на нём подбор
 * значило бы остановить бронирование целиком. Что не понято — того
 * просто нет, и работают встроенные формулы.
 */
function normalizeRows(rule: unknown): FitRow[] {
  const raw = (rule as { rows?: unknown })?.rows
  if (!Array.isArray(raw)) return []

  const out: FitRow[] = []
  for (const r of raw) {
    const row = r as Partial<FitRow>
    if (
      (row.param === 'height' || row.param === 'weight'
        || row.param === 'shoeSizeEu' || row.param === 'headCircumference')
      && typeof row.min === 'number' && typeof row.max === 'number'
      && typeof row.value === 'string' && row.min < row.max
    ) {
      out.push({ param: row.param, min: row.min, max: row.max, value: row.value })
    }
  }
  return out
}

/**
 * Значение по таблице для конкретного параметра.
 *
 * ⚠️ Полуоткрытые границы `[min, max)`: рост ровно 170 при строках
 * 165–170 и 170–175 попадает во вторую, однозначно. С включительными
 * границами он попал бы в обе, и результат зависел бы от порядка строк
 * в выборке — то есть менялся бы сам по себе.
 */
export function applyTable(rows: FitRow[], params: Record<string, number | undefined>): string | null {
  for (const r of rows) {
    const v = params[r.param]
    if (v === undefined || v === null) continue
    if (v >= r.min && v < r.max) return r.value
  }
  return null
}

/**
 * Новая версия таблицы подбора.
 *
 * ⚠️ Старая АРХИВИРУЕТСЯ, а не удаляется: в заказах лежат снимки
 * подбора, и «почему клиенту дали 157» через сезон восстанавливается
 * только по той редакции, что действовала тогда.
 */
export async function publishFitTable(
  c: PoolClient,
  opts: {
    tenantId: string
    categoryId: string
    chartYear: number
    rows: FitRow[]
    staffId: string
  },
): Promise<{ id: string, version: number }> {
  if (!opts.rows.length) {
    throw apiError('VALIDATION_FAILED', 'Таблица без строк ничего не подбирает')
  }

  // ⚠️ Пересечения внутри одного параметра запрещены: две строки на
  // один рост означают, что подбор зависит от порядка выборки, то есть
  // недетерминирован. Это тот же инвариант, что у правил цен.
  const byParam = new Map<string, FitRow[]>()
  for (const r of opts.rows) {
    const list = byParam.get(r.param) ?? []
    list.push(r)
    byParam.set(r.param, list)
  }
  for (const [param, list] of byParam) {
    const sorted = [...list].sort((a, b) => a.min - b.min)
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i]!.min < sorted[i - 1]!.max) {
        throw apiError(
          'VALIDATION_FAILED',
          `Строки по «${param}» пересекаются: ${sorted[i - 1]!.min}–${sorted[i - 1]!.max} и ${sorted[i]!.min}–${sorted[i]!.max}. `
          + 'Подбор стал бы зависеть от порядка строк.',
        )
      }
    }
  }

  const { rows: prev } = await c.query<{ max: number | null }>(
    `SELECT max(version) AS max FROM fit_rule
     WHERE tenant_id = $1 AND category_id = $2`,
    [opts.tenantId, opts.categoryId],
  )
  const version = (prev[0]?.max ?? 0) + 1

  await c.query(
    `UPDATE fit_rule SET is_active = false, archived_at = now()
     WHERE tenant_id = $1 AND category_id = $2 AND archived_at IS NULL`,
    [opts.tenantId, opts.categoryId],
  )

  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO fit_rule
       (tenant_id, category_id, rule, chart_year, version, is_active)
     VALUES ($1, $2, $3, $4, $5, true)
     RETURNING id`,
    [opts.tenantId, opts.categoryId,
     JSON.stringify({ rows: opts.rows }), opts.chartYear, version],
  )

  await audit(c, {
    tenantId: opts.tenantId,
    staffId: opts.staffId,
    action: 'fit_rule.published',
    targetType: 'fit_rule',
    targetId: rows[0]!.id,
    reason: `новая версия таблицы подбора №${version}`,
    after: { categoryId: opts.categoryId, version, chartYear: opts.chartYear, rows: opts.rows.length },
  })

  return { id: rows[0]!.id, version }
}
