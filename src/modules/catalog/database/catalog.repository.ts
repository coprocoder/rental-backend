/**
 * Чтение каталога витрины из БД: тенант, филиалы, варианты, услуги, сезоны.
 *
 * ⚠️ Здесь И ТОЛЬКО здесь живёт SQL модуля. Запрос в обработчике нельзя
 * переиспользовать вторым маршрутом без копирования и нельзя проверить
 * без HTTP; вынесенный сюда — можно и то, и другое.
 *
 * ⚠️ Функции возвращают СЫРЫЕ строки, без локализации и группировки:
 * `localized()` зависит от локали запроса, а группировка по категориям —
 * это форма ответа, то есть дело эндпоинта. Здесь только то, что пришло
 * из БД.
 *
 * ⚠️ `tenantBySlug` ходит ВНЕ тенантного контекста — это единственный
 * законный случай на витрине: слаг как раз и превращается в tenant_id,
 * до его разбора выставлять `app.tenant_id` нечем. Таблица `tenant` под
 * RLS не ходит (см. `unscoped` в `kernel/db.ts`). Всё остальное здесь
 * принимает уже готовый `PoolClient` из транзакции, открытой сервисом.
 */
import type { PoolClient } from 'pg'
import type { Db } from '../../../kernel/db'
import type {
  BranchRow, CatalogRow, OffSeasonRow, SeasonRow, ServiceRow, TenantRow,
} from '../catalog.types'

/**
 * Тенант по слагу витрины.
 *
 * ⚠️ Возвращает `null`, а не бросает: какой ответ показать клиенту —
 * решает контроллер. Запрос к БД, бросающий HTTP-ошибку, — это маршрут
 * в маскировке, и переиспользовать его вторым сценарием уже нельзя.
 */
export async function tenantBySlug(db: Db, slug: string): Promise<TenantRow | null> {
  const rows = await db.unscoped<TenantRow>(
    `SELECT id, name, day_mode, group_threshold, theme FROM tenant
     WHERE slug = $1 AND archived_at IS NULL`,
    [slug],
  )
  return rows[0] ?? null
}

export async function branchesOf(c: PoolClient, tenantId: string): Promise<BranchRow[]> {
  const { rows } = await c.query<BranchRow>(
    `SELECT id, name, address, timezone FROM branch
     WHERE tenant_id = $1 AND archived_at IS NULL ORDER BY name`,
    [tenantId],
  )
  return rows
}

/**
 * Варианты, доступные на дату аренды.
 *
 * ⚠️ Сезон проверяется против даты АРЕНДЫ, а не «сегодня»: в апреле
 * бронируют сапборд на июль, и он должен быть в каталоге. Месяц берётся
 * в поясе филиала: 1 мая 00:30 по Красноярску — ещё 30 апреля по UTC.
 */
export async function catalogRows(
  c: PoolClient,
  tenantId: string,
  rentalFrom: string,
): Promise<CatalogRow[]> {
  const { rows } = await c.query<CatalogRow>(
    `SELECT c.code AS category_code, c.name AS category_name, c.body_params,
            v.id AS variant_id, v.code AS variant_code, v.name AS variant_name,
            v.size_bucket,
            COALESCE(MAX(pd.capacity), 0) AS capacity,
            MAX(pr.amount) AS price
     FROM category c
     JOIN inventory_variant v ON v.category_id = c.id AND v.archived_at IS NULL
     JOIN branch b ON b.id = v.branch_id
     LEFT JOIN pool_day pd ON pd.variant_id = v.id AND pd.day = current_date
     LEFT JOIN price_rule pr ON pr.variant_id = v.id AND pr.rule_kind = 'base'
                            AND pr.is_active AND pr.archived_at IS NULL
     WHERE c.tenant_id = $1 AND c.archived_at IS NULL AND c.code <> 'service'
       AND season_month_active(
         EXTRACT(MONTH FROM $2::date)::int,
         c.season_from_month, c.season_to_month)
     GROUP BY c.code, c.name, c.body_params, c.sort_order, v.id, v.code, v.name, v.size_bucket, v.sort_order
     ORDER BY c.sort_order, v.sort_order, v.code`,
    [tenantId, rentalFrom],
  )
  return rows
}

/**
 * Категории, скрытые по сезону на выбранную дату.
 *
 * Форма говорит «сапборды с мая», а не молча показывает урезанный
 * каталог: клиент должен понимать, что товар существует и когда за ним
 * прийти.
 */
export async function offSeasonRows(
  c: PoolClient,
  tenantId: string,
  rentalFrom: string,
): Promise<OffSeasonRow[]> {
  const { rows } = await c.query<OffSeasonRow>(
    `SELECT DISTINCT c.code, c.name, c.season_from_month, c.season_to_month
     FROM category c
     JOIN inventory_variant v ON v.category_id = c.id AND v.archived_at IS NULL
     JOIN branch b ON b.id = v.branch_id
     WHERE c.tenant_id = $1 AND c.archived_at IS NULL AND c.code <> 'service'
       AND NOT season_month_active(
         EXTRACT(MONTH FROM $2::date)::int,
         c.season_from_month, c.season_to_month)`,
    [tenantId, rentalFrom],
  )
  return rows
}

/**
 * Услуги — отдельный список, не категория снаряжения.
 *
 * У них нет ни размеров, ни наличия, ни сезона, и форма показывает их
 * иначе («добавить заточку»), а не карточкой с размерной сеткой.
 */
export async function serviceRows(c: PoolClient, tenantId: string): Promise<ServiceRow[]> {
  const { rows } = await c.query<ServiceRow>(
    `SELECT v.id, v.code, v.name, MAX(pr.amount) AS price
     FROM inventory_variant v
     JOIN category c ON c.id = v.category_id AND c.code = 'service'
     LEFT JOIN price_rule pr ON pr.variant_id = v.id AND pr.rule_kind = 'base'
                            AND pr.is_active AND pr.archived_at IS NULL
     WHERE v.tenant_id = $1 AND v.archived_at IS NULL
     GROUP BY v.id, v.code, v.name, v.sort_order
     ORDER BY v.sort_order, v.code`,
    [tenantId],
  )
  return rows
}

/**
 * Сезоны ВСЕХ категорий тенанта, а не только скрытых сейчас.
 *
 * Вкладки «зима/лето» должны знать обе стороны, иначе не из чего
 * строить выбор.
 *
 * ⚠️ `ORDER BY` обязателен, хотя список маленький и порядок «и так
 * выглядит стабильным». `SELECT DISTINCT` без сортировки НЕ ДАЁТ
 * гарантии порядка: Postgres выбирает между хеш-агрегацией и
 * сортировкой по статистике таблицы, и порядок меняется вместе с
 * планом. Проверено на этой самой базе — те же строки приходят как
 * `sup, snowboard, helmet…` при `enable_hashagg=on` и по алфавиту
 * при `off`.
 *
 * Клиент сегодня к порядку не привязан (вкладки строятся по своему
 * списку сезонов), но от порядка зависит СВЕРКА С ЭТАЛОНОМ — способ,
 * которым проверяется весь переезд. Ответ, меняющийся сам по себе,
 * делает её бесполезной: расхождение перестаёт что-либо значить.
 */
export async function seasonRows(c: PoolClient, tenantId: string): Promise<SeasonRow[]> {
  const { rows } = await c.query<SeasonRow>(
    `SELECT DISTINCT code, season_from_month, season_to_month
     FROM category
     WHERE tenant_id = $1 AND archived_at IS NULL
     ORDER BY code`,
    [tenantId],
  )
  return rows
}
