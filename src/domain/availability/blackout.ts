/**
 * Точечное отключение позиции на даты (18.2).
 *
 * Четвёртая, независимая ось недоступности. Три существующие её
 * не закрывают: сезон — про категорию и про каждый год, расписание —
 * про филиал целиком, ёмкость пула — про то, сколько физически есть.
 * Здесь: один вариант не продаётся с 3 по 5 января, потому что уехал
 * на выставку или лежит в ремонте.
 *
 * ⚠️ Отключение НЕ трогает счётчики пула. «Сколько есть» и «продавать
 * ли» — разные вопросы: занулив ёмкость, мы потеряли бы исходное число
 * и не смогли бы честно снять отключение, а уже стоящие в эти дни
 * брони обязаны сохраниться.
 *
 * ⚠️ Причина обязательна. Клиент видит отключение как «нет мест», и
 * через месяц никто не вспомнит, почему позиция выпала из продажи.
 */
import type { PoolClient } from 'pg'
import { apiError } from '~/kernel/errors'

export interface BlackoutInput {
  tenantId: string
  variantId: string
  /** Первый отключённый день, «YYYY-MM-DD». */
  from: string
  /** Последний отключённый день ВКЛЮЧИТЕЛЬНО. */
  to: string
  reason: string
  staffId?: string
}

/**
 * Отключает позицию на диапазон дней включительно.
 *
 * ⚠️ Границы приходят включительными, потому что так их называет
 * человек («с 3 по 5»), а хранятся полуоткрытыми [from, to) — как все
 * интервалы в проекте. Преобразование делается здесь, в одном месте,
 * чтобы «по 5 января» не превратилось в «по 4-е» где-то по дороге.
 */
export async function blackoutVariant(c: PoolClient, input: BlackoutInput): Promise<void> {
  if (input.to < input.from) {
    throw apiError('VALIDATION_FAILED', 'Конец диапазона раньше начала')
  }
  if (!input.reason.trim()) {
    throw apiError('VALIDATION_FAILED', 'Нужна причина отключения')
  }

  await c.query(
    `INSERT INTO variant_blackout (tenant_id, variant_id, days, reason, created_by)
     VALUES ($1, $2, daterange($3::date, ($4::date + 1), '[)'), $5, $6)`,
    [input.tenantId, input.variantId, input.from, input.to, input.reason.trim(), input.staffId ?? null],
  )
}

/**
 * Снимает отключения, пересекающиеся с диапазоном.
 *
 * ⚠️ Удаляются ЦЕЛИКОМ все пересекающиеся записи, а не вырезается
 * кусок. Отключение — это решение человека с причиной; резать его
 * пополам значит оставить в базе половину чужого решения с той же
 * формулировкой, которая ей больше не соответствует.
 */
export async function clearBlackout(
  c: PoolClient,
  opts: { tenantId: string, variantId: string, from: string, to: string },
): Promise<number> {
  const { rowCount } = await c.query(
    `DELETE FROM variant_blackout
      WHERE tenant_id = $1 AND variant_id = $2
        AND days && daterange($3::date, ($4::date + 1), '[)')`,
    [opts.tenantId, opts.variantId, opts.from, opts.to],
  )
  return rowCount ?? 0
}

/** Действующие отключения варианта — для админки. */
export async function listBlackouts(
  c: PoolClient,
  opts: { tenantId: string, variantId: string },
): Promise<{ from: string, to: string, reason: string }[]> {
  const { rows } = await c.query<{ from: string, to: string, reason: string }>(
    `SELECT lower(days)::text AS from,
            (upper(days) - 1)::text AS to,
            reason
       FROM variant_blackout
      WHERE tenant_id = $1 AND variant_id = $2 AND upper(days) > current_date
      ORDER BY lower(days)`,
    [opts.tenantId, opts.variantId],
  )
  return rows
}
