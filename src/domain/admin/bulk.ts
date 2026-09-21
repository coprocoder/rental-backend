/**
 * Массовые операции над инвентарём (13.6).
 *
 * ⚠️ Без них админка становится мучением на второй сезон
 * (../rental-docs/docs/04-тз/20-фронтенд/26-админка.md): предсезонная заточка партии,
 * инвентаризация после сезона, смена сезонного прайса — всё это
 * действия над десятками позиций сразу, и делать их по одной никто
 * не станет. Не сделают — значит данные разойдутся с реальностью,
 * и система перестанет быть полезной.
 *
 * ⚠️ Каждая операция сначала ПОКАЗЫВАЕТ, что затронет, и только потом
 * выполняется. Массовое действие вслепую — это способ испортить
 * сто позиций одним нажатием, и откатывать их придётся по одной.
 * Поэтому dryRun не флаг «на всякий случай», а обязательный шаг
 * интерфейса.
 *
 * ⚠️ Причина обязательна для всего, что уменьшает или меняет учёт.
 * Основание то же, что у одиночного списания (13.5.1): через месяц
 * массовое списание без причины неотличимо от кражи, только масштабом
 * больше.
 */
import type { PoolClient } from 'pg'
import { apiError } from '~/kernel/errors'
import { audit } from '../core/order-lifecycle'
import { localized, type I18nField } from '~/common/utils/i18n-field'

export interface BulkFilter {
  categoryId?: string
  branchId?: string
  /** Подстрока кода или названия. */
  q?: string
}

export interface AffectedVariant {
  variantId: string
  code: string
  name: string
  categoryName: string
  branchName: string
  total: number
  /** Сколько занято бронями вперёд — предупреждение при списании. */
  bookedAhead: number
}

/**
 * Что попадёт под операцию.
 *
 * ⚠️ Возвращает и будущие брони: списать позицию, на которую есть
 * бронь, можно (расхождение не блокирует работу, железное правило №12),
 * но сотрудник обязан это видеть — клиент приедет за забронированным.
 */
export async function preview(
  c: PoolClient,
  opts: { tenantId: string, filter: BulkFilter, branchIds?: string[], locale?: string },
): Promise<AffectedVariant[]> {
  const scoped = (opts.branchIds?.length ?? 0) > 0
  const { rows } = await c.query<Record<string, unknown>>(
    `SELECT iv.id AS variant_id, iv.code, iv.name,
            cat.code AS category_code, cat.name AS category_name,
            b.name AS branch_name,
            COALESCE((
              SELECT SUM(m.qty) FROM movement m
              WHERE m.variant_id = iv.id AND m.branch_id = iv.branch_id
            ), 0)::int AS total,
            COALESCE((
              SELECT SUM(ol.qty) FROM order_line ol
              JOIN rental_order o ON o.id = ol.order_id
              WHERE ol.variant_id = iv.id
                AND o.status IN ('awaiting_confirm', 'confirmed', 'issued',
                                 'partially_returned', 'overdue')
                AND upper(o.period) > now()
            ), 0)::int AS booked_ahead
     FROM inventory_variant iv
     JOIN category cat ON cat.id = iv.category_id
     JOIN branch b ON b.id = iv.branch_id
     WHERE iv.tenant_id = $1
       AND iv.archived_at IS NULL
       AND cat.code <> 'service'
       AND ($2::uuid IS NULL OR iv.category_id = $2)
       AND ($3::uuid IS NULL OR iv.branch_id = $3)
       AND ($4 = '' OR iv.code ILIKE '%' || $4 || '%' OR iv.name::text ILIKE '%' || $4 || '%')
       AND (NOT $5 OR iv.branch_id = ANY($6::uuid[]))
     ORDER BY cat.sort_order, iv.sort_order, iv.code`,
    [
      opts.tenantId,
      opts.filter.categoryId ?? null,
      opts.filter.branchId ?? null,
      opts.filter.q?.trim() ?? '',
      scoped,
      opts.branchIds ?? [],
    ],
  )

  const locale = opts.locale ?? 'ru'
  return rows.map((r) => ({
    variantId: r.variant_id as string,
    code: r.code as string,
    name: localized(r.name as I18nField, locale, r.code as string),
    categoryName: localized(r.category_name as I18nField, locale, r.category_code as string),
    branchName: r.branch_name as string,
    total: (r.total as number) ?? 0,
    bookedAhead: (r.booked_ahead as number) ?? 0,
  }))
}

export type BulkAction = 'write_off' | 'service' | 'rebucket'

/**
 * Выполняет операцию над отобранными вариантами.
 *
 * ⚠️ Списки вариантов приходят ЯВНО, а не пересчитываются по фильтру
 * заново. Между показом и подтверждением данные могли измениться —
 * кто-то завёл новую позицию, — и «выполнить по фильтру» затронуло бы
 * то, чего сотрудник не видел. Он подтверждает конкретный список.
 */
export async function applyBulk(
  c: PoolClient,
  opts: {
    tenantId: string
    action: BulkAction
    variantIds: string[]
    /** Для списания и обслуживания: сколько единиц с каждой позиции. */
    qty?: number
    /** Для перебакетирования: куда переносим. */
    targetCategoryId?: string
    reason: string
    staffId: string
    shiftId?: string
  },
): Promise<{ affected: number }> {
  if (!opts.variantIds.length) {
    throw apiError('VALIDATION_FAILED', 'Не выбрано ни одной позиции')
  }
  if (!opts.reason.trim()) {
    throw apiError('VALIDATION_FAILED', 'Массовая операция требует причины')
  }
  // ⚠️ Верхняя граница: массовая операция на тысячу позиций почти
  // наверняка означает промах в фильтре, а не намерение.
  if (opts.variantIds.length > 500) {
    throw apiError('VALIDATION_FAILED', 'Больше 500 позиций за раз — проверьте фильтр')
  }

  let affected = 0

  if (opts.action === 'write_off' || opts.action === 'service') {
    const qty = opts.qty ?? 1
    if (qty < 1) throw apiError('VALIDATION_FAILED', 'Количество должно быть положительным')

    for (const variantId of opts.variantIds) {
      // ⚠️ Движения пишутся ПО ОДНОМУ на позицию, а не одной строкой
      // на всю операцию: наличие считается суммой движений по варианту,
      // и агрегированная запись просто не попала бы в этот подсчёт.
      await c.query(
        `INSERT INTO movement
           (tenant_id, branch_id, variant_id, kind, qty, service_kind,
            staff_id, shift_id, reason)
         SELECT $1, iv.branch_id, iv.id, $3::movement_kind, $4,
                $5::service_kind, $6, $7, $8
         FROM inventory_variant iv
         WHERE iv.id = $2 AND iv.tenant_id = $1`,
        [
          opts.tenantId, variantId,
          // ⚠️ to_service, а не «service»: это значение из movement_kind,
          // и оно парное с from_service — вещь вернётся из обслуживания
          // отдельным движением.
          opts.action === 'write_off' ? 'write_off' : 'to_service',
          opts.action === 'write_off' ? -qty : -qty,
          opts.action === 'service' ? 'inspection' : null,
          opts.staffId, opts.shiftId ?? null, opts.reason,
        ],
      )

      // Ёмкость пула следует за количеством: иначе списанное система
      // продолжит продавать, а отданное в обслуживание — тем более.
      await c.query(
        `UPDATE pool_day SET capacity = GREATEST(0, capacity - $3)
         WHERE tenant_id = $1 AND variant_id = $2 AND day >= current_date`,
        [opts.tenantId, variantId, qty],
      )
      affected++
    }
  } else {
    // Перебакетирование: перенос вариантов в другую категорию.
    // ⚠️ После первого сезона размерные сетки почти всегда
    // пересматривают (26-админка.md) — это не редкая операция.
    if (!opts.targetCategoryId) {
      throw apiError('VALIDATION_FAILED', 'Не указана категория, куда переносим')
    }
    const { rowCount } = await c.query(
      `UPDATE inventory_variant
       SET category_id = $3
       WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
      [opts.tenantId, opts.variantIds, opts.targetCategoryId],
    )
    affected = rowCount ?? 0
  }

  // ⚠️ ОДНА запись в журнал на всю операцию, со списком позиций:
  // пятьсот отдельных записей превратили бы журнал в шум, а понять
  // «что это было» можно только видя операцию целиком.
  await audit(c, {
    tenantId: opts.tenantId,
    staffId: opts.staffId,
    action: `bulk.${opts.action}`,
    targetType: 'inventory_variant',
    targetId: opts.variantIds[0]!,
    reason: opts.reason,
    after: {
      action: opts.action,
      variantIds: opts.variantIds,
      qty: opts.qty,
      targetCategoryId: opts.targetCategoryId,
      affected,
    },
  })

  return { affected }
}
