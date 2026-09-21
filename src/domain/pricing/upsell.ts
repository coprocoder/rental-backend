/**
 * Допродажа на стойке (17.21).
 *
 * Клиент уже здесь, уже платит, и половина позиций проката — мелочь,
 * о которой он просто не подумал: перчатки, маска, защита, заточка.
 * Спросить на стойке дешевле любой рекламы.
 *
 * ⚠️ ТОЛЬКО ПО ОПУБЛИКОВАННОМУ ПРАЙСУ. Цена берётся тем же движком,
 * что и онлайн: у публичного договора не бывает «цены на стойке»
 * (ГК ст. 626 п. 3), а импровизация сотрудника — это ещё и дыра
 * в кассе. Позиция без действующего правила цены не предлагается
 * вовсе: «договоритесь на месте» — ровно то, чего система не делает.
 *
 * ⚠️ НЕ БОЛЕЕ ТРЁХ. Ограничение не косметическое. Список из
 * пятнадцати галочек сотрудник в спешке пролистывает не читая, и
 * допродажа превращается в шум, который замедляет выдачу. Три —
 * столько, сколько человек успевает произнести вслух, пока клиент
 * надевает ботинки.
 *
 * ⚠️ НЕ МОДАЛЬНО. Окно поверх экрана выдачи перекрывает то, ради
 * чего сотрудник сюда пришёл, и требует его закрыть — то есть
 * заставляет ответить «нет» нажатием. Предложение живёт строкой
 * в самом экране: его можно не заметить и спокойно продолжить.
 * Это разница между подсказкой и препятствием.
 */
import type { PoolClient } from 'pg'
import { quote } from './pricing'
import type { DayMode } from '~/common/contract/day-count'
import { localized, type I18nField } from '~/common/utils/i18n-field'

/** Сколько предлагать. Больше — это уже не подсказка. */
export const UPSELL_LIMIT = 3

export interface UpsellCandidate {
  variantId: string
  name: string
  categoryCode: string
  /** Цена за весь срок заказа, посчитанная сервером. */
  amount: string
  /** Свободно на интервал. Услуги интервалом не ограничены. */
  available: boolean
  /** Почему предложено — сотруднику нужно это произнести. */
  why: string
}

/**
 * Что предложить к этому заказу.
 *
 * Порядок отбора: сначала то, чего у заказа нет из «мелочи»
 * (перчатки, маска, защита), потом услуги. Внутри — по частоте,
 * с какой это докупали к похожим заказам.
 *
 * ⚠️ Частота считается по СВОИМ заказам тенанта, а не зашита
 * в код: у горного проката и у городского докупают разное, и
 * подбирать это должны данные, а не наша догадка.
 */
export async function upsellFor(
  c: PoolClient,
  opts: {
    tenantId: string
    orderId: string
    branchId: string
    dayMode: DayMode
    timezone: string
  },
): Promise<UpsellCandidate[]> {
  const { rows: orderRows } = await c.query<{
    starts_at: Date
    ends_at: Date
    status: string
    total_amount: string
  }>(
    `SELECT lower(period) AS starts_at, upper(period) AS ends_at, status::text,
            total_amount::text
     FROM rental_order WHERE id = $1`,
    [opts.orderId],
  )
  const order = orderRows[0]
  if (!order) return []

  // ⚠️ Уже выданному заказу допродажа бессмысленна: клиент ушёл.
  // Возврат — тем более: там считают ущерб, а не продают.
  if (order.status !== 'confirmed' && order.status !== 'awaiting_confirm') return []

  /**
   * Кандидаты: позиции филиала, которых в заказе ещё нет.
   *
   * ⚠️ Отбор по частоте совместной покупки, а не по марже: «предложи
   * самое дорогое» — это против интереса клиента, а прокат живёт
   * возвращаемостью, а не одним чеком.
   */
  const { rows } = await c.query<{
    id: string
    name: I18nField
    code: string
    category_code: string
    category_name: I18nField
    together: string
  }>(
    `WITH mine AS (
       SELECT variant_id FROM order_line WHERE order_id = $2
     ),
     -- ⚠️ Категории заказа, а не только его варианты. Список кодов
     -- «ski / board / boots» в коде был бы неверен по построению:
     -- коды категорий заводит сам прокат, и у демо-тенанта это
     -- snowboard. Захардкоженный список молча пропускал главную
     -- позицию в допродажу — поймано при сквозной проверке.
     mine_categories AS (
       SELECT DISTINCT v.category_id
       FROM order_line ol
       JOIN inventory_variant v ON v.id = ol.variant_id
       WHERE ol.order_id = $2
     ),
     -- Как часто эту позицию докупали к заказам, где было то же,
     -- что и здесь. Считается по заказам самого тенанта.
     together AS (
       SELECT ol.variant_id, count(DISTINCT ol.order_id)::text AS n
       FROM order_line ol
       JOIN order_line peer ON peer.order_id = ol.order_id
       WHERE ol.tenant_id = $1
         AND peer.variant_id IN (SELECT variant_id FROM mine)
         AND ol.variant_id NOT IN (SELECT variant_id FROM mine)
       GROUP BY ol.variant_id
     ),
     ranked AS (
       SELECT v.id, v.name, v.code, cat.code AS category_code,
              cat.name AS category_name,
              COALESCE(tg.n, '0') AS together,
              -- ⚠️ По ОДНОЙ позиции на категорию: клиенту нужен шлем,
              -- а не выбор между размерами M и L. Три строки, из
              -- которых две — размеры одного и того же, съедают весь
              -- лимит и выглядят как неисправность. Размер подбирают
              -- на стойке, для того она и есть.
              row_number() OVER (
                PARTITION BY cat.id
                ORDER BY COALESCE(tg.n, '0')::int DESC, v.code
              ) AS rn
       FROM inventory_variant v
       JOIN category cat ON cat.id = v.category_id
       LEFT JOIN together tg ON tg.variant_id = v.id
       WHERE v.tenant_id = $1
         AND v.branch_id = $3
         AND v.archived_at IS NULL
         AND v.id NOT IN (SELECT variant_id FROM mine WHERE variant_id IS NOT NULL)
         -- ⚠️ Категории, уже представленные в заказе, исключаются
         -- целиком: у клиента есть сноуборд — второй ему не нужен,
         -- даже другого размера. Проверка по КАТЕГОРИИ, а не
         -- по варианту: иначе «сноуборд 147» предлагается тому,
         -- кто взял «сноуборд 157».
         AND cat.id NOT IN (SELECT category_id FROM mine_categories)
         -- ⚠️ Только то, что в сезоне на даты аренды. Без этого
         -- к летней аренде сапборда предлагаются горнолыжные ботинки
         -- и шлем — поймано при сквозной проверке на демо-данных.
         -- Функция та же, что и в отчётах и в наличии: второй
         -- реализации сезонности быть не должно.
         AND season_month_active(
               EXTRACT(MONTH FROM $5::timestamptz)::int,
               cat.season_from_month, cat.season_to_month)
     )
     SELECT id, name, code, category_code, category_name, together
     FROM ranked
     WHERE rn = 1
     ORDER BY together::int DESC, category_code
     LIMIT $4`,
    [opts.tenantId, opts.orderId, opts.branchId, UPSELL_LIMIT * 3, order.starts_at],
  )

  if (rows.length === 0) return []

  // ⚠️ Цена — через тот же quote, что и всё остальное. Своего расчёта
  // здесь нет и быть не может (железное правило №1).
  const priced = await quote(c, {
    tenantId: opts.tenantId,
    lines: rows.map((r) => ({
      variantId: r.id,
      qty: 1,
      kind: r.category_code === 'service' ? 'service' as const : 'rental' as const,
    })),
    from: order.starts_at,
    to: order.ends_at,
    dayMode: opts.dayMode,
    timezone: opts.timezone,
  })

  const byVariant = new Map(priced.breakdown.map((b) => [b.variantId, b.lineTotal]))

  // Наличие на интервал — одним запросом по дням, не наивным SUM.
  const { rows: free } = await c.query<{ variant_id: string, free: number }>(
    `SELECT pd.variant_id, MIN(pd.capacity - pd.qty_booked)::int AS free
     FROM pool_day pd
     WHERE pd.variant_id = ANY($1::uuid[])
       AND pd.day >= ($2::timestamptz AT TIME ZONE $4)::date
       AND pd.day <= ($3::timestamptz AT TIME ZONE $4)::date
     GROUP BY pd.variant_id`,
    [rows.map((r) => r.id), order.starts_at, order.ends_at, opts.timezone],
  )
  const freeBy = new Map(free.map((f) => [f.variant_id, f.free]))

  /**
   * Потолок цены допродажи.
   *
   * ⚠️ Допродажа — это «добавить мелочь», а не «продать вторую
   * аренду». Позиция дороже самого заказа выглядит как ошибка
   * системы и подрывает доверие к остальным предложениям: сотрудник,
   * увидев ботинки за 1000 ₽ к заказу на 400 ₽, перестанет читать
   * этот блок вообще.
   *
   * Половина суммы заказа — граница, а не наука: важно, что она
   * относительная. Абсолютный порог в рублях устарел бы к следующему
   * сезону и не пережил бы вторую валюту.
   */
  const orderTotal = Number(order.total_amount ?? 0)
  const ceiling = orderTotal > 0 ? orderTotal / 2 : Infinity

  const out: UpsellCandidate[] = []
  for (const r of rows) {
    const amount = byVariant.get(r.id)
    // ⚠️ Нет цены в опубликованном прайсе — нет предложения.
    // Продавать «договоримся» на стойке нельзя.
    if (!amount || amount === '0.00') continue

    const isService = r.category_code === 'service'
    // Услуга интервалом не ограничена: заточка не занимает пул.
    const available = isService || (freeBy.get(r.id) ?? 0) > 0
    if (!available) continue

    // ⚠️ Дороже половины заказа — это не допродажа.
    if (Number(amount) > ceiling) continue

    // ⚠️ Имя категории обязательно: у вариантов имена — это размеры
    // («L», «M (55–59)»), и без категории сотрудник не поймёт,
    // перчатки это или шлем. Произносить вслух ему придётся именно
    // это название.
    const category = localized(r.category_name, 'ru', r.category_code)
    const size = localized(r.name, 'ru', r.code)

    out.push({
      variantId: r.id,
      name: size && size !== category ? `${category}, ${size}` : category,
      categoryCode: r.category_code,
      amount,
      available: true,
      why: Number(r.together) > 0
        ? `часто берут вместе (${r.together})`
        : 'есть в наличии',
    })
    if (out.length >= UPSELL_LIMIT) break
  }

  return out
}

/**
 * Добавляет допроданную позицию в заказ.
 *
 * ⚠️ Сумма пересчитывается сервером и записывается в снимок цены
 * заказа: клиенту показывают итог, а не «плюс сколько-то». Снимок —
 * это то, по чему потом считают возврат и спор (железное правило №6).
 */
export async function addUpsellLine(
  c: PoolClient,
  opts: {
    tenantId: string
    orderId: string
    variantId: string
    qty: number
    dayMode: DayMode
    timezone: string
    staffId: string
  },
): Promise<{ total: string, amount: string }> {
  const { rows: orderRows } = await c.query<{
    starts_at: Date
    ends_at: Date
    status: string
    price_breakdown: { breakdown?: unknown[], days?: number } | null
    total_amount: string
  }>(
    `SELECT lower(period) AS starts_at, upper(period) AS ends_at, status::text,
            price_breakdown, total_amount
     FROM rental_order WHERE id = $1 FOR UPDATE`,
    [opts.orderId],
  )
  const order = orderRows[0]
  if (!order) throw new Error('Заказ не найден')
  if (order.status !== 'confirmed' && order.status !== 'awaiting_confirm') {
    throw new Error('Допродажа возможна только до выдачи')
  }

  const { rows: catRows } = await c.query<{ category_code: string }>(
    `SELECT cat.code AS category_code
     FROM inventory_variant v JOIN category cat ON cat.id = v.category_id
     WHERE v.id = $1 AND v.tenant_id = $2 AND v.archived_at IS NULL`,
    [opts.variantId, opts.tenantId],
  )
  const categoryCode = catRows[0]?.category_code
  if (!categoryCode) throw new Error('Позиция не найдена')
  const isService = categoryCode === 'service'

  const priced = await quote(c, {
    tenantId: opts.tenantId,
    lines: [{
      variantId: opts.variantId,
      qty: opts.qty,
      kind: isService ? 'service' : 'rental',
    }],
    from: order.starts_at,
    to: order.ends_at,
    dayMode: opts.dayMode,
    timezone: opts.timezone,
  })

  const amount = priced.breakdown[0]?.lineTotal
  if (!amount || amount === '0.00') {
    throw new Error('У позиции нет действующей цены в прайсе')
  }

  // ⚠️ Тип параметра задан явно (::order_line_kind): без каста один
  // и тот же $3 выводится и как enum в VALUES, и как text в сравнении,
  // и Postgres отказывается — «inconsistent types deduced».
  await c.query(
    `INSERT INTO order_line (tenant_id, order_id, kind, variant_id, qty, period, amount, status)
     VALUES ($1, $2, $3::order_line_kind, $4, $5,
             CASE WHEN $3::text = 'service' THEN NULL
                  ELSE tstzrange($6, $7) END,
             $8, 'reserved')`,
    [opts.tenantId, opts.orderId, isService ? 'service' : 'rental',
     opts.variantId, opts.qty, order.starts_at, order.ends_at, amount],
  )

  // ⚠️ Снимок цены дополняется, а не переписывается: строки, уже
  // согласованные с клиентом, менять нельзя — на них он согласился.
  const snapshot = [...(order.price_breakdown?.breakdown ?? []), {
    variantId: opts.variantId,
    variantName: priced.breakdown[0]!.variantName,
    qty: opts.qty,
    unitTotal: amount,
    days: priced.days,
  }]

  const { rows: totalRows } = await c.query<{ total: string }>(
    `UPDATE rental_order
     SET total_amount = total_amount + $2::numeric,
         price_breakdown = jsonb_set(
           COALESCE(price_breakdown, '{}'::jsonb), '{breakdown}', $3::jsonb)
     WHERE id = $1
     RETURNING total_amount::text AS total`,
    [opts.orderId, amount, JSON.stringify(snapshot)],
  )

  // ⚠️ Автор и причина — в журнал: у каждой автоматики есть ручной
  // эквивалент, и у каждого ручного действия есть след
  // (железное правило №13).
  await c.query(
    `INSERT INTO event (tenant_id, aggregate_type, aggregate_id, kind, payload, actor_type, actor_id)
     VALUES ($1, 'order', $2, 'order.upsold', $3, 'staff', $4)`,
    [opts.tenantId, opts.orderId,
     JSON.stringify({ variantId: opts.variantId, qty: opts.qty, amount }),
     opts.staffId],
  )

  return { total: totalRows[0]!.total, amount }
}
