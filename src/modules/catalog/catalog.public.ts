/**
 * Фасад модуля catalog.
 *
 * Владение записью: `inventory_variant`, `category`, `item`, `movement`
 * пишет только этот модуль. Читают его данные почти все — `category`
 * нужна девяти областям, — и это разрешено: запрет стоит на ЗАПИСИ.
 * Чтение чужой таблицы в худшем случае даёт устаревшую картину, а запись
 * из двух модулей означает два места, где живёт правило, и они разойдутся
 * (`plans/01-МОДУЛИ.md`).
 */
export type { CatalogCategory, CatalogVariant, GetCatalogInput } from './usecase/get-catalog'
export { getCatalog } from './usecase/get-catalog'
