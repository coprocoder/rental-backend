/**
 * Типы модуля каталог: строки БД и доменные формы.
 *
 * ⚠️ Два вида типов лежат РЯДОМ, но значат разное:
 *
 *   *Row   — строка таблицы как её отдаёт Postgres (snake_case).
 *            Живёт внутри модуля, наружу не уходит.
 *   прочие — доменные формы, которые модуль отдаёт наружу.
 *
 * ⚠️ Наружу (через `index.ts`) экспортируются ТОЛЬКО вторые. Если
 * сосед привяжется к `{ tenant_id, branch_pickup_id, … }`, переименование
 * колонки сломает чужой модуль — ровно та связность, против которой
 * затеяны границы.
 */

/* ───────────────────────── строки БД ───────────────────────── */

/**
 * ⚠️ `type` с индексной сигнатурой, а не `interface`: `db.unscoped`
 * ограничен `Record<string, unknown>`, а интерфейс такому ограничению
 * не удовлетворяет — у него нет индексной сигнатуры, и TS это отвергает
 * (TS2344). У остальных строк этой проблемы нет: они читаются через
 * `c.query`, где ограничения нет.
 */
export type TenantRow = {
  id: string
  name: string
  day_mode: string
  group_threshold: number
  theme: Record<string, unknown>
  [key: string]: unknown
}

export interface BranchRow {
  id: string
  name: string
  address: string | null
  timezone: string
}

export interface CatalogRow {
  category_code: string
  category_name: { ru?: string }
  body_params: string[]
  variant_id: string
  variant_code: string
  variant_name: { ru?: string }
  size_bucket: Record<string, unknown>
  capacity: number
  price: string | null
}

export interface OffSeasonRow {
  code: string
  name: { ru?: string }
  season_from_month: number | null
  season_to_month: number | null
}

export interface ServiceRow {
  id: string
  code: string
  name: { ru?: string }
  price: string | null
}

export interface SeasonRow {
  code: string
  season_from_month: number | null
  season_to_month: number | null
}

/* ──────────────────── доменные формы ──────────────────── */

export interface GetCatalogInput {
  /** Слаг витрины: `demo` в `/r/demo`. */
  tenant: string
  locale: string
  /**
   * Календарная дата начала аренды, `YYYY-MM-DD`.
   *
   * ⚠️ Именно календарная, а не момент времени: клиент выбирает день в
   * календаре филиала, и месяц для сезонного фильтра берётся от него
   * напрямую, без преобразования поясов. Преобразование расходилось
   * между SSR и клиентом и меняло ключ кеша запроса.
   */
  rentalFrom: string
}

export interface CatalogVariant {
  id: string
  code: string
  name: string
  bucket: Record<string, unknown>
  capacity: number
  price: string | null
}

export interface CatalogCategory {
  code: string
  name: string
  bodyParams: string[]
  variants: CatalogVariant[]
}
