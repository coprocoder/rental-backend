/**
 * Список модулей — ЕДИНСТВЕННОЕ место вне каталога модуля, которое
 * правится при добавлении нового.
 *
 * ⚠️ Явный список, а не автозагрузка каталогов. Автозагрузка выглядит
 * удобнее ровно до первой ошибки: забытый модуль не отличается от
 * сломавшегося, порядок регистрации неявный, а набор маршрутов
 * приложения нельзя прочитать — только выполнить.
 */
import type { App } from '../transport/types'
import type { Deps } from '../kernel/deps'
import { registerCatalogRoutes } from './catalog/transport/catalog.routes'

export function registerModules(app: App, deps: Deps): void {
  registerCatalogRoutes(app, deps)
}
