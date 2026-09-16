/**
 * Сценарий «показать каталог витрины».
 *
 * ⚠️ В сигнатуре нет ни Request, ни PoolClient — только вход, контекст
 * и зависимости. Поэтому сценарий одинаково вызывается из HTTP, из теста
 * и из будущего мобильного приложения стойки, а транспорт остаётся
 * заменяемым (`plans/02-СЛОИ.md`).
 *
 * ⚠️ Тенант здесь определяется СЛАГОМ витрины, а не сессией: это
 * публичный контур, клиент анонимен. Поэтому usecase принимает slug и
 * сам находит tenantId — единственный случай, когда он не приходит
 * готовым в Ctx.
 */
import type { Deps } from '../../../kernel/deps'
import { apiError } from '../../../kernel/errors'
import { localized } from '../../../kernel/i18n-field'
import { describeSeason } from '../../../shared/season'
import { pickTheme } from '../../../shared/theme'
import { getLimits } from '../../pricing/pricing.public'
import {
  branchesOf, catalogRows, offSeasonRows, seasonRows, serviceRows, tenantBySlug,
} from '../gateway/catalog.gateway'

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

export async function getCatalog(input: GetCatalogInput, deps: Deps) {
  const tenant = await tenantBySlug(deps.db, input.tenant)
  if (!tenant) throw apiError('TENANT_NOT_FOUND', 'Прокат не найден')

  // ⚠️ ОДНА транзакция на весь экран, а не по одной на запрос. Раньше
  // каждое чтение открывало свою — шесть независимых снимков данных,
  // между которыми склад мог измениться: каталог показывал вариант,
  // которого в списке сезонов уже не было.
  return deps.db.tx(tenant.id, async (c) => {
    const [branches, rows, offSeason, services, seasons, limits] = await Promise.all([
      branchesOf(c, tenant.id),
      catalogRows(c, tenant.id, input.rentalFrom),
      offSeasonRows(c, tenant.id, input.rentalFrom),
      serviceRows(c, tenant.id),
      seasonRows(c, tenant.id),
      // ⚠️ Горизонт бронирования отдаётся клиенту, чтобы календарь НЕ ДАВАЛ
      // выбрать даты, на которые заказ всё равно не примут. Раньше выбрать
      // было можно, и человек получал «мест нет» вместо «так далеко нельзя»:
      // за горизонтом склад просто не расписан, и наличие читается нулём.
      getLimits(c, tenant.id),
    ])

    // Группируем в категории: форма собирается из body_params.
    const categories = new Map<string, CatalogCategory>()

    for (const r of rows) {
      let cat = categories.get(r.category_code)
      if (!cat) {
        cat = {
          code: r.category_code,
          name: localized(r.category_name, input.locale, r.category_code),
          bodyParams: r.body_params ?? [],
          variants: [],
        }
        categories.set(r.category_code, cat)
      }
      cat.variants.push({
        id: r.variant_id,
        code: r.variant_code,
        name: localized(r.variant_name, input.locale, r.variant_code),
        bucket: r.size_bucket ?? {},
        capacity: Number(r.capacity),
        price: r.price,
      })
    }

    return {
      /** До скольких дней вперёд принимается бронь. */
      maxAdvanceDays: limits.maxAdvanceDays,
      /**
       * Сезон каждой категории: месяцы, когда она выдаётся.
       *
       * ⚠️ Отдаётся отдельно от categories, потому что categories — это
       * только то, что доступно на ВЫБРАННУЮ дату. Вкладке «лето» нужно
       * знать про сапборды и зимой.
       */
      seasons: seasons.map((s) => ({
        code: s.code,
        fromMonth: s.season_from_month,
        toMonth: s.season_to_month,
      })),
      // ⚠️ Тема — ОГРАНИЧЕННЫЙ набор токенов, не произвольный CSS
      // (../rental-docs/docs/04-тз/20-фронтенд/23-виджет.md): тенант меняет цвет и радиус,
      // а не вёрстку. Произвольный CSS сломал бы доступность и контраст,
      // и каждая жалоба «у нас виджет сломался» была бы нашей.
      theme: pickTheme(tenant.theme),
      services: services.map((sv) => ({
        id: sv.id,
        code: sv.code,
        name: localized(sv.name, input.locale, sv.code),
        price: sv.price,
      })),
      offSeason: offSeason.map((cat) => ({
        code: cat.code,
        name: localized(cat.name, input.locale, cat.code),
        season: describeSeason({ fromMonth: cat.season_from_month, toMonth: cat.season_to_month }),
      })),

      tenant: {
        name: tenant.name,
        dayMode: tenant.day_mode,
        groupThreshold: tenant.group_threshold,
      },
      branches,
      categories: [...categories.values()],
    }
  })
}
