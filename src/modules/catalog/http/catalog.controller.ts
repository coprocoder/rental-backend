/**
 * Публичные маршруты каталога.
 *
 * ⚠️ Маршрут делает ровно четыре вещи: разбирает запрос, валидирует,
 * зовёт сценарий, отдаёт результат. Ни SQL, ни правил здесь нет — иначе
 * сценарий нельзя переиспользовать и нельзя протестировать без HTTP.
 */
import * as v from 'valibot'
import type { App } from '../../../transport/types'
import type { Deps } from '../../../kernel/deps'
import { parse } from '../../../transport/validate'
import { getCatalog } from '../service/catalog.service'
import { documentRoute } from '~/transport/openapi/registry'

const Query = v.object({
  tenant: v.pipe(v.string('Не указан тенант'), v.minLength(1, 'Не указан тенант')),
  // ⚠️ Язык названий — параметр, а не константа (8.7): названия
  // категорий и вариантов это ДАННЫЕ тенанта, и в другой стране прокат
  // заведёт свои.
  locale: v.optional(v.string(), 'ru'),
  /**
   * ⚠️ Мягкий разбор: неверный формат даёт «сегодня», а не отказ.
   * Первый экран формы обязан показать каталог, даже если параметр
   * пришёл мусорным — точную дату клиент задаст сам.
   */
  from: v.optional(v.string(), ''),
})

/**
 * Ответ витрины.
 *
 * ⚠️ Описан схемой ради двух вещей сразу: OpenAPI для внешних
 * разработчиков виджета и типы для фронта, где после выноса бэкенда
 * выводить их стало неоткуда (19.40, 19.42).
 *
 * ⚠️ Цены — СТРОКИ: деньги хранятся как `numeric`, и превращение
 * в `number` теряет копейки на больших суммах. Клиент их только
 * показывает, считает сервер (железное правило 1).
 */
const CatalogResponse = v.object({
  tenant: v.object({
    name: v.string(),
    dayMode: v.string(),
    groupThreshold: v.number(),
  }),
  branches: v.array(v.object({
    id: v.pipe(v.string(), v.uuid()),
    name: v.string(),
    address: v.nullable(v.string()),
    timezone: v.string(),
  })),
  categories: v.array(v.object({
    code: v.string(),
    name: v.string(),
    bodyParams: v.array(v.string()),
    variants: v.array(v.object({
      id: v.pipe(v.string(), v.uuid()),
      code: v.string(),
      name: v.string(),
      // Размерная сетка: состав зависит от категории.
      bucket: v.nullable(v.record(v.string(), v.unknown())),
      capacity: v.number(),
      price: v.string(),
    })),
  })),
  /** Позиции вне сезона: показываются серыми, с объяснением. */
  offSeason: v.array(v.object({
    code: v.string(),
    name: v.string(),
    season: v.string(),
  })),
  services: v.array(v.object({
    id: v.pipe(v.string(), v.uuid()),
    code: v.string(),
    name: v.string(),
    price: v.string(),
  })),
  seasons: v.array(v.object({
    code: v.string(),
    fromMonth: v.nullable(v.number()),
    toMonth: v.nullable(v.number()),
  })),
  theme: v.record(v.string(), v.string()),
  maxAdvanceDays: v.number(),
})

documentRoute({
  method: 'get',
  path: '/v1/public/catalog',
  summary: 'Каталог витрины: категории, варианты, цены, сезоны и тема',
  scope: 'public',
  query: Query,
  response: CatalogResponse,
})

export function registerCatalogRoutes(app: App, deps: Deps): void {
  app.get('/v1/public/catalog', async (req) => {
    const q = parse(Query, req.query)

    const rentalFrom = /^\d{4}-\d{2}-\d{2}$/.test(q.from)
      ? q.from
      // Без параметра — сегодня по UTC: первый экран формы показывает
      // актуальное, а точную дату клиент задаст сам.
      : deps.clock().toISOString().slice(0, 10)

    return getCatalog({ tenant: q.tenant, locale: q.locale, rentalFrom }, deps)
  })
}
