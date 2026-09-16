/**
 * Учёт отказов и накопление спроса.
 *
 * ⚠️ Главное, что здесь появляется: СОБЫТИЕ ОТКАЗА С КОДОМ ПРИЧИНЫ.
 * До него сам факт отказа нигде не фиксировался (../rental-docs/docs/04-тз/10-бэкенд/
 * 23-прогноз-закупки.md), а значит данных для закупки не было вовсе —
 * ни задним числом их не восстановить, ни оценить, чего складу не
 * хватает.
 *
 * Зачем это продукту: конкуренты знают, ЧТО у них не забронировали.
 * Мы знаем, КОМУ отказали и с какими параметрами тела — потому что
 * собираем рост, вес и размер обуви в самой форме. Разница между
 * «сноубордов 157 не хватило 12 раз» и «отказали 12 людям роста
 * 175–182 и веса 70–80 кг» — это разница между констатацией и готовым
 * решением о закупке.
 *
 * ⚠️ Накопление идёт ДО обезличивания (8B.8): retention_until сотрёт
 * персональные данные, и если агрегаты не посчитаны заранее, истории
 * не останется. Поэтому demand_daily пишется в день отказа.
 *
 * ⚠️ Сумма упущенного — ОЦЕНКА, а не факт, и так и подписывается в
 * отчёте: человек мог бы и не оформить заказ. Выдавать её за
 * недополученную выручку нельзя, иначе прокат примет решение о
 * закупке на завышенных цифрах.
 */
import type { PoolClient } from 'pg'
import { getWorkerPool } from '~/kernel/db'
import { localized, type I18nField } from '~/common/utils/i18n-field'

/**
 * Код причины отказа.
 *
 * Список закрытый: свободный текст в аналитике не группируется, и
 * отчёт «почему нам отказывают» перестаёт складываться.
 */
export type RefusalReason =
  /** Нет свободных единиц на интервал. Основной источник закупки. */
  | 'no_availability'
  /** Выдача или возврат вне часов работы филиала. */
  | 'outside_hours'
  /** Уперлись в лимит: доля пула, активные брони, глубина вперёд. */
  | 'limit_exceeded'
  /** Ушёл на шаге контактов — форма слишком длинная или передумал. */
  | 'abandoned_contacts'
  /** Не принял согласия. */
  | 'consent_declined'
  /** Увидел цену и не продолжил. */
  | 'price'
  /** Категория не в сезоне на даты аренды. К закупке отношения не имеет. */
  | 'out_of_season'
  /** ⚠️ Режим unverified: наличие не ведётся, отказал оператор вручную. */
  | 'operator_declined'

export interface RefusalInput {
  tenantId: string
  branchId: string
  variantId?: string
  /** Интервал, который запрашивали. */
  from?: Date
  to?: Date
  reason: RefusalReason
  /**
   * Параметры тела — то, из-за чего отчёт вообще возможен.
   *
   * ⚠️ Без ПД: только сами измерения, без телефона и имени. Это делает
   * агрегат безопасным для долгого хранения и не мешает обезличиванию.
   */
  bodyParams?: Record<string, number>
  /** Оценка упущенного по прайсу на дату отказа. */
  estimatedAmount?: string
  correlationId?: string
}

/**
 * Фиксирует отказ ОТДЕЛЬНОЙ транзакцией.
 *
 * ⚠️ Именно отдельной, и это не оптимизация. Отказ выбрасывает
 * исключение, а транзакция заказа на нём откатывается — запись,
 * сделанная внутри неё, исчезла бы вместе с попыткой брони. То есть
 * весь сбор данных о неудовлетворённом спросе молча не работал бы,
 * и обнаружилось бы это только через сезон по пустому отчёту.
 *
 * Идёт под ролью воркера: сохранить отказ важнее, чем удержать его
 * в тенантном контексте, а tenant_id пишется явно из аргумента.
 */
export async function recordRefusalDetached(input: RefusalInput): Promise<void> {
  const client = await getWorkerPool().connect()
  try {
    await client.query('BEGIN')
    await recordRefusal(client, input)
    await client.query('COMMIT')
  } catch {
    await client.query('ROLLBACK')
    // ⚠️ Ошибку глотаем намеренно: неудача записи аналитики не должна
    // подменять клиенту причину отказа. Клиент должен увидеть «нет
    // наличия», а не «внутренняя ошибка».
  } finally {
    client.release()
  }
}

/**
 * Фиксирует отказ в переданной транзакции.
 *
 * Пишет и событие (для хронологии заказа и разбора инцидентов), и
 * агрегат demand_daily (для отчёта закупки). Событие подробное и
 * живёт до обезличивания; агрегат обезличен и живёт всегда.
 *
 * ⚠️ Использовать только там, где транзакция НЕ откатится. Если отказ
 * сопровождается исключением — recordRefusalDetached.
 */
export async function recordRefusal(
  c: PoolClient,
  input: RefusalInput,
): Promise<void> {
  await c.query(
    `INSERT INTO event
       (tenant_id, aggregate_type, aggregate_id, kind, payload,
        correlation_id, actor_type)
     VALUES ($1, 'refusal', COALESCE($2, gen_random_uuid()), $3, $4, $5, 'customer')`,
    [
      input.tenantId,
      input.variantId ?? null,
      `refusal.${input.reason}`,
      JSON.stringify({
        variantId: input.variantId,
        branchId: input.branchId,
        from: input.from?.toISOString(),
        to: input.to?.toISOString(),
        bodyParams: input.bodyParams,
        estimatedAmount: input.estimatedAmount,
      }),
      input.correlationId ?? null,
    ],
  )

  // Агрегат по дню: без него отчёт пришлось бы собирать по событиям,
  // которые к тому времени уже обезличены или удалены.
  //
  // ⚠️ Размерный бакет входит в КЛЮЧ агрегата, а не лежит списком
  // внутри строки: отчёт группирует именно по бакетам («отказали
  // людям роста 175–182»), и группировка по ключу считается индексом,
  // а не разбором jsonb на каждой строке.
  if (input.variantId) {
    await c.query(
      `INSERT INTO demand_daily
         (tenant_id, branch_id, variant_id, day, size_bucket,
          reason_code, requests, rejected, est_lost_revenue)
       VALUES ($1, $2, $3, current_date, $4, $5, 1, 1, $6)
       ON CONFLICT (branch_id, day, variant_id, size_bucket, reason_code) DO UPDATE
         SET requests = demand_daily.requests + 1,
             rejected = demand_daily.rejected + 1,
             est_lost_revenue = COALESCE(demand_daily.est_lost_revenue, 0)
                                + COALESCE(excluded.est_lost_revenue, 0)`,
      [
        input.tenantId,
        input.branchId,
        input.variantId,
        // Бакеты, а не точные значения: рост 178 в отчёте бесполезен,
        // а группа 175–182 показывает, чего докупить.
        input.bodyParams ? bucketKey(input.bodyParams) : null,
        input.reason,
        input.estimatedAmount ?? null,
      ],
    )
  }
}

/**
 * Строковый ключ бакета для агрегата.
 *
 * Порядок полей фиксирован, иначе одна и та же группа даст два
 * разных ключа и разъедется на две строки отчёта.
 */
export function bucketKey(p: Record<string, number>): string {
  const b = bucketize(p)
  return ['height', 'weight', 'shoeSizeEu', 'headCircumference']
    .filter((k) => b[k])
    .map((k) => `${k}:${b[k]}`)
    .join(';')
}

/**
 * Огрубляет параметры тела до размерных групп.
 *
 * ⚠️ Именно бакеты, а не точные значения: отчёт должен читаться как
 * «отказали людям роста 175–182», а не как список из 12 разных чисел.
 * Плюс огрубление снижает риск сопоставления записи с человеком.
 */
export function bucketize(p: Record<string, number>): Record<string, string> {
  const out: Record<string, string> = {}

  if (p.height) {
    // Шаг 7 см примерно соответствует шагу длины доски 5 см.
    const lo = Math.floor(p.height / 7) * 7
    out.height = `${lo}-${lo + 6}`
  }
  if (p.weight) {
    const lo = Math.floor(p.weight / 10) * 10
    out.weight = `${lo}-${lo + 9}`
  }
  if (p.shoeSizeEu) {
    const lo = Math.floor(p.shoeSizeEu / 2) * 2
    out.shoeSizeEu = `${lo}-${lo + 1}`
  }
  if (p.headCircumference) {
    const lo = Math.floor(p.headCircumference / 4) * 4
    out.headCircumference = `${lo}-${lo + 3}`
  }

  return out
}

export interface LostDemandRow {
  variantId: string
  variantName: string
  refusals: number
  estimatedAmount: string
  /** Загрузка имеющихся единиц за период, 0–1. */
  utilization: number
}

/**
 * Отчёт упущенного спроса — основной отчёт продукта.
 *
 * Читается сразу: где отказов много и загрузка 100% — доложить;
 * где загрузка низкая — часть можно продать.
 *
 * ⚠️ Знаменатель загрузки — доступные единицы МИНУС в ремонте, иначе
 * загрузка занижается на сезонное обслуживание и выглядит так, будто
 * склад простаивает.
 */
export async function lostDemandReport(
  c: PoolClient,
  opts: { tenantId: string, branchId?: string, from: string, to: string },
): Promise<LostDemandRow[]> {
  const { rows } = await c.query<{
    variant_id: string
    variant_name: I18nField
    refusals: number
    estimated_amount: string | null
    booked_days: number
    capacity_days: number
  }>(
    `WITH refusals AS (
       SELECT d.variant_id,
              SUM(d.rejected)::int AS refusals,
              SUM(d.est_lost_revenue) AS estimated_amount
       FROM demand_daily d
       JOIN inventory_variant v ON v.id = d.variant_id
       JOIN category c ON c.id = v.category_id
       WHERE d.tenant_id = $1
         AND ($2::uuid IS NULL OR d.branch_id = $2)
         AND d.day BETWEEN $3::date AND $4::date
         -- Летний отказ по сноуборду — не сигнал к закупке сноубордов.
         AND season_month_active(EXTRACT(MONTH FROM d.day)::int,
                                 c.season_from_month, c.season_to_month)
         -- Только отказы по наличию: остальные причины к закупке
         -- отношения не имеют, их смешивание искажает отчёт.
         AND d.reason_code = 'no_availability'
       GROUP BY d.variant_id
     ),
     load AS (
       -- ⚠️ Только дни В СЕЗОНЕ категории: иначе сапборды зимой дают
       -- «ёмкость есть, броней нет» = 0%, и отчёт советует «продать
       -- часть», хотя они просто ждут лета.
       SELECT pd.variant_id,
              SUM(pd.qty_booked)::int AS booked_days,
              SUM(pd.capacity)::int AS capacity_days
       FROM pool_day pd
       JOIN inventory_variant v ON v.id = pd.variant_id
       JOIN category c ON c.id = v.category_id
       WHERE pd.tenant_id = $1 AND pd.day BETWEEN $3::date AND $4::date
         AND season_month_active(EXTRACT(MONTH FROM pd.day)::int,
                                 c.season_from_month, c.season_to_month)
       GROUP BY pd.variant_id
     )
     SELECT v.id AS variant_id, v.name AS variant_name,
            COALESCE(r.refusals, 0) AS refusals,
            r.estimated_amount,
            COALESCE(l.booked_days, 0) AS booked_days,
            COALESCE(l.capacity_days, 0) AS capacity_days
     FROM inventory_variant v
     LEFT JOIN refusals r ON r.variant_id = v.id
     LEFT JOIN load l ON l.variant_id = v.id
     WHERE v.tenant_id = $1 AND v.archived_at IS NULL
       AND ($2::uuid IS NULL OR v.branch_id = $2)
       AND (r.refusals > 0 OR l.booked_days > 0)
     ORDER BY COALESCE(r.refusals, 0) DESC, v.sort_order`,
    [opts.tenantId, opts.branchId ?? null, opts.from, opts.to],
  )

  return rows.map((r) => ({
    variantId: r.variant_id,
    // ⚠️ Через server/utils/i18n-field, а не `?.ru`: жёстко вписанный язык
    // не грепается как ошибка и переживает переезд в другую страну.
    variantName: localized(r.variant_name as I18nField, 'ru', 'Позиция'),
    refusals: r.refusals,
    estimatedAmount: r.estimated_amount ?? '0.00',
    utilization: r.capacity_days > 0 ? r.booked_days / r.capacity_days : 0,
  }))
}
