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
import { getCatalog } from '../usecase/get-catalog'

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
