/**
 * Расчёт наличия — ядро системы.
 *
 * ⚠️ Главное решение: наличие это ДВЕ РАЗНЫЕ ВЕЛИЧИНЫ, а не одно число
 * (../rental-docs/docs/04-тз/10-бэкенд/12-наличие-и-жизненный-цикл.md):
 *
 *   обязательства  сколько обещано на интервал     ← из броней
 *   физическое     сколько реально на складе       ← из журнала движений
 *
 * Они пересекаются, но не совпадают. Вещь может быть забронирована и
 * физически отсутствовать (не вернули в срок) — самая опасная комбинация.
 *
 * Свободно к бронированию НА ДАТУ  = capacity − обязательства
 * Свободно к выдаче СЕЙЧАС         = physical − выдано
 *
 * Это разные запросы к разным данным, и путать их нельзя.
 */
import type { PoolClient } from 'pg'
import { expandToDays } from '~/common/contract/day-count'

export interface AvailabilityRequest {
  tenantId: string
  variantId: string
  from: Date
  to: Date
  /** Пояс филиала: «сегодня» считается по нему, не по браузеру. */
  timezone: string
  qty?: number
}

export interface AvailabilityResult {
  available: boolean
  /** Минимальное свободное количество по дням интервала. */
  freeUnits: number
  /** Дни, в которые не хватает. Пусто, если всё свободно. */
  shortageDays: string[]
}

/**
 * Свободно ли на интервал — для бронирования.
 *
 * ⚠️ КРИТИЧНО: нельзя считать как `SUM(qty) WHERE period && requested`.
 * Такой запрос сильно завышает занятость: брони на 3 и на 10 февраля обе
 * пересекают запрос «1–15 февраля», но никогда не сосуществуют.
 * Считаем по КАЖДОМУ дню отдельно и берём минимум свободного.
 */
export async function checkAvailability(
  c: PoolClient,
  req: AvailabilityRequest,
): Promise<AvailabilityResult> {
  const qty = req.qty ?? 1

  // ⚠️ Режим unverified: прокат не ведёт учёт этой позиции, и система
  // не должна отказывать по данным, которых нет. Барьер внедрения
  // снимается именно здесь (../rental-docs/docs/04-тз/10-бэкенд/12-наличие...): требовать
  // заполненный склад до первого заказа значит не получить ни одного.
  //
  // Режим на уровне ВАРИАНТА, а не только тенанта: лыжи могут быть
  // учтены, а перчатки нет — иначе получается «всё или ничего»,
  // и никто не начнёт.
  const { rows: mode } = await c.query<{ inventory_mode: string }>(
    `SELECT inventory_mode FROM inventory_variant WHERE id = $1`,
    [req.variantId],
  )
  if (mode[0]?.inventory_mode === 'unverified') {
    return { available: true, freeUnits: qty, shortageDays: [] }
  }
  const days = expandToDays(req.from, req.to, req.timezone)
  if (days.length === 0) {
    return { available: false, freeUnits: 0, shortageDays: [] }
  }

  // ⚠️ Отключение позиции (18.2) — ЧЕТВЁРТАЯ ось недоступности, рядом
  // с сезоном, расписанием филиала и ёмкостью пула. Учитывается прямо
  // здесь, а не проверкой уровнем выше: иначе её забудут в одном
  // из вызовов, и отключённая позиция где-то останется продаваемой.
  //
  // Отключённый день даёт free = 0, но счётчики пула не трогает:
  // «сколько есть» и «продавать ли» — разные вопросы.
  //
  // ⚠️ Резерв под выдачу с улицы (10.10) — ПЯТАЯ ось, и по той же
  // причине считается здесь же. Настройка жила в
  // branch_offline_reserve и не читалась нигде: админка обещала
  // тенанту «забронировать её онлайн нельзя», а онлайн разбирал весь
  // склад. Резерв задаётся на (филиал, категория), поэтому берётся
  // через вариант — у него есть и branch_id, и category_id.
  //
  // ⚠️ Как и отключение, резерв НЕ трогает счётчики пула: он
  // уменьшает продаваемое, а не физическое. Придержанное лежит на
  // складе и выдаётся тому, кто пришёл без брони.
  //
  // ⚠️ Процент считается от ёмкости КАЖДОГО дня, а не от максимума
  // по интервалу: ёмкость меняется по дням (часть парка уехала), и
  // 50% от чужого большого дня съели бы весь маленький.
  //
  // ⚠️ GREATEST(..., 0): резерв больше пула не должен уводить
  // свободное в минус — отрицательное число пролезло бы в витрину
  // и в арифметику пула.
  /**
   * ⚠️ ОДИН механизм на позицию, а не два одновременно.
   *
   * При `count` ёмкость берётся из `pool_day` — предпосчитанного
   * счётчика по дням. При `labeled` она СЧИТАЕТСЯ ПО ЕДИНИЦАМ, и
   * `pool_day` не участвует вовсе.
   *
   * Почему не синхронизировать счётчик с единицами: `capacity`
   * правят шесть разных мест, и седьмое — это седьмой шанс забыть.
   * Так и появилось расхождение, найденное на стенде: sb-157 имел
   * 11 вещей физически и 6 в счётчике, то есть витрина не продавала
   * половину парка и НЕ СООБЩАЛА об этом. Вычисляемое значение
   * забыть невозможно.
   *
   * ⚠️ Железное правило 5 не нарушается: считаем ПО ДНЯМ, а не
   * наивным SUM по пересечению. Меняется источник ёмкости, а не
   * способ подсчёта.
   */
  const { rows: trackRows } = await c.query<{ tracking: string }>(
    `SELECT cat.tracking FROM inventory_variant v
       JOIN category cat ON cat.id = v.category_id
      WHERE v.id = $1`,
    [req.variantId],
  )
  const byItems = trackRows[0]?.tracking === 'labeled'

  const { rows } = await c.query<{ day: string, free: number }>(
    `WITH reserve AS (
       SELECT r.mode, r.value
         FROM inventory_variant iv
         JOIN branch_offline_reserve r
           ON r.branch_id = iv.branch_id AND r.category_id = iv.category_id
        WHERE iv.id = $1
     ),
     -- ⚠️ Один проход по единицам, а не подзапрос на каждую: на
     -- парке в 300 вещей это 18 мс против 66 мс (замерено).
     -- Здесь только то, что не зависит от дня: живая и не в сервисе.
     usable AS (
       SELECT i.id
         FROM item i
        WHERE $3::bool
          AND i.variant_id = $1
          AND i.archived_at IS NULL
          AND i.id NOT IN (
            SELECT m.item_id FROM movement m
             WHERE m.item_id IS NOT NULL
               AND m.kind IN ('to_service', 'from_service')
             GROUP BY m.item_id
            HAVING -SUM(m.qty) > 0
          )
     ),
     -- ⚠️ Базовая ёмкость позиции — для дней, которых НЕТ в календаре.
     -- pool_day не заполняется заранее на горизонт: строка появляется
     -- в момент брони. Отсутствие строки означает «в этот день никто
     -- ничего не бронировал», то есть свободен весь склад, а не ноль.
     -- Раньше за границей заполненного календаря позиция показывалась
     -- занятой при полном складе (19.43).
     --
     -- ⚠️ Берётся из ПОСЛЕДНЕГО известного дня, а не из суммы движений:
     -- в календаре учтены приходы, списания и правки количества,
     -- а сумма движений накапливает ошибки — на демо-стенде повторный
     -- запуск сидера задвоил её (14 против 7 реальных).
     base AS (
       SELECT pd.capacity
         FROM pool_day pd
        WHERE pd.variant_id = $1
        ORDER BY pd.day DESC
        LIMIT 1
     ),
     -- Ёмкость дня: при поимённом учёте — сколько вещей свободно
     -- именно в этот день; иначе — счётчик пула.
     cap AS (
       SELECT d::date AS day,
              CASE WHEN $3::bool THEN (
                SELECT count(*)::int FROM usable u
                 WHERE NOT EXISTS (
                         SELECT 1 FROM order_line ol
                          WHERE ol.item_id = u.id
                            AND ol.status IN ('reserved', 'picked_up')
                            AND ol.period && tstzrange(d::date, d::date + 1)
                       )
                   AND NOT EXISTS (
                         SELECT 1 FROM item_blackout ib
                          WHERE ib.item_id = u.id AND ib.days @> d::date
                       )
              ) ELSE COALESCE(pd.capacity, (SELECT capacity FROM base), 0)
                     - COALESCE(pd.qty_booked, 0) END AS free_raw,
              -- Для процента резерва нужна ПОЛНАЯ ёмкость дня, а не
              -- остаток: иначе процент считался бы от уже занятого.
              CASE WHEN $3::bool THEN (SELECT count(*)::int FROM usable)
                   ELSE COALESCE(pd.capacity, (SELECT capacity FROM base), 0) END AS total,
              bl.variant_id AS blacked
         FROM unnest($2::date[]) AS d
         LEFT JOIN pool_day pd
           ON NOT $3::bool AND pd.variant_id = $1 AND pd.day = d::date
         LEFT JOIN LATERAL (
           SELECT vb.variant_id FROM variant_blackout vb
            WHERE vb.variant_id = $1 AND vb.days @> d::date
            LIMIT 1
         ) bl ON true
     )
     SELECT cap.day::text AS day,
            CASE WHEN cap.blacked IS NOT NULL THEN 0
                 ELSE GREATEST(
                   cap.free_raw
                     - COALESCE((
                         SELECT CASE
                                  WHEN rs.mode = 'percent'
                                    THEN floor(cap.total * rs.value / 100.0)
                                  ELSE rs.value
                                END::int
                           FROM reserve rs
                       ), 0),
                   0)
            END AS free
     FROM cap
     ORDER BY cap.day`,
    [req.variantId, days, byItems],
  )

  const shortageDays = rows.filter((r) => r.free < qty).map((r) => r.day)
  const freeUnits = rows.length ? Math.min(...rows.map((r) => r.free)) : 0

  return {
    available: shortageDays.length === 0,
    freeUnits: Math.max(0, freeUnits),
    shortageDays,
  }
}

/**
 * Физическое наличие сейчас — сумма журнала движений.
 *
 * physical НЕ хранится числом, которое можно рассинхронизировать.
 * Отсюда: любое расхождение объяснимо — видно операцию и автора,
 * а история получается бесплатно.
 */
export async function physicalStock(
  c: PoolClient,
  tenantId: string,
  variantId: string,
): Promise<number> {
  const { rows } = await c.query<{ total: string }>(
    `SELECT COALESCE(SUM(qty), 0)::text AS total
     FROM movement
     WHERE tenant_id = $1 AND variant_id = $2`,
    [tenantId, variantId],
  )
  return Number(rows[0]?.total ?? 0)
}

/**
 * Занимает единицы пула на интервал.
 *
 * ⚠️ Строки берутся в ОТСОРТИРОВАННОМ порядке (variant_id, day) —
 * иначе дедлоки на многодневных бронях, когда две транзакции идут
 * по одним и тем же дням в разном порядке. Железное правило №14:
 * порядок блокировок один на весь код.
 *
 * Переполнение отклоняет CHECK на pool_day, а не проверка здесь:
 * проверка в коде гонку не закрывает.
 */
export async function reservePool(
  c: PoolClient,
  req: AvailabilityRequest,
): Promise<void> {
  const qty = req.qty ?? 1
  const days = expandToDays(req.from, req.to, req.timezone)

  // Один запрос вместо цикла: порядок гарантирован ORDER BY внутри,
  // а СУБД сама сериализует конкурентные обновления по строкам.
  //
  // ⚠️ INSERT … ON CONFLICT, а не UPDATE. Календарь не заполняется
  // заранее на горизонт (19.43), и в дальнем дне строки может не быть:
  // `UPDATE` менял бы ноль строк МОЛЧА — бронь не записана, а витрина
  // показывает позицию свободной. Это продажа одной вещи дважды.
  //
  // ⚠️ Ёмкость новой строки берётся из последнего известного дня —
  // того же источника, что и расчёт наличия. Иначе день, созданный
  // бронью, получил бы ёмкость, не равную той, по которой эту бронь
  // только что разрешили.
  await c.query(
    `WITH d AS (
       SELECT unnest($3::date[]) AS day ORDER BY 1
     ),
     base AS (
       SELECT capacity FROM pool_day
        WHERE variant_id = $2 ORDER BY day DESC LIMIT 1
     )
     INSERT INTO pool_day (tenant_id, variant_id, day, qty_booked, capacity)
     SELECT $1, $2, d.day, $4, COALESCE((SELECT capacity FROM base), 0)
       FROM d
     ON CONFLICT (variant_id, day)
     DO UPDATE SET qty_booked = pool_day.qty_booked + $4`,
    [req.tenantId, req.variantId, days, qty],
  )
}

/** Освобождает единицы пула: отмена, досрочный возврат, снятие по дедлайну. */
export async function releasePool(
  c: PoolClient,
  req: AvailabilityRequest,
): Promise<void> {
  const qty = req.qty ?? 1
  const days = expandToDays(req.from, req.to, req.timezone)

  await c.query(
    `WITH d AS (
       SELECT unnest($3::date[]) AS day ORDER BY 1
     )
     UPDATE pool_day pd
     SET qty_booked = GREATEST(0, pd.qty_booked - $4)
     FROM d
     WHERE pd.tenant_id = $1 AND pd.variant_id = $2 AND pd.day = d.day`,
    [req.tenantId, req.variantId, days, qty],
  )
}

/**
 * Буфер на подготовку по категории варианта.
 *
 * ⚠️ Реализуется РАСШИРЕНИЕМ интервала, а не изменением оператора
 * пересечения (железное правило №4). Полуоткрытый [начало, конец)
 * означает, что возврат в 15:00 и выдача в 15:00 не конфликтуют —
 * физически же клиент вернул мокрый ботинок, и его в ту же секунду
 * выдают следующему.
 *
 * По умолчанию 0: прокат работает в день подключения без настройки.
 */
export async function bufferMinutesFor(
  c: PoolClient,
  variantId: string,
): Promise<number> {
  const { rows } = await c.query<{ buffer_minutes: number }>(
    `SELECT c.buffer_minutes
     FROM inventory_variant v
     JOIN category c ON c.id = v.category_id
     WHERE v.id = $1`,
    [variantId],
  )
  return rows[0]?.buffer_minutes ?? 0
}
