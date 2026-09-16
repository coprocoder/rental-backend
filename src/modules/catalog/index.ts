/**
 * Публичный контракт модуля каталога.
 *
 * ⚠️ Это ЕДИНСТВЕННОЕ, что видят соседние модули. `database/`,
 * `service/` и `http/` — частное дело модуля, и правило
 * `module-private-internals` в CI не даст импортировать их снаружи.
 *
 * Владение записью: `inventory_variant`, `category`, `item`, `movement`
 * пишет только этот модуль. Читают его данные почти все — `category`
 * нужна девяти областям, — и это РАЗРЕШЕНО: запрет стоит на ЗАПИСИ.
 * Чтение чужой таблицы в худшем случае даёт устаревшую картину, а
 * запись из двух модулей означает два места, где живёт правило, и они
 * разойдутся. `capacity` в `pool_day` правили шесть мест — и разошлись.
 */
export type {
  CatalogCategory, CatalogVariant, GetCatalogInput,
} from './catalog.types'
export { getCatalog } from './service/catalog.service'
export { registerCatalogRoutes } from './http/catalog.controller'
export { registerCatalogAdminRoutes } from './http/admin.controller'
