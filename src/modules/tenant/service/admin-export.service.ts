/**
 * Выгрузки в CSV (13.17).
 *
 * ⚠️ «Всё, что видно, можно выгрузить» — требование ко всем экранам
 * (26-админка.md): владелец считает в Excel, и без выгрузки он
 * пересчитывает вручную либо не пересчитывает вовсе. Второе хуже:
 * решения принимаются на глаз.
 *
 * ⚠️ Разделитель — точка с запятой, кодировка с BOM. Не педантизм:
 * русский Excel открывает CSV с запятой одной колонкой, потому что
 * запятая у него десятичный разделитель, а без BOM показывает
 * кириллицу крякозябрами. Выгрузка, которую надо чинить руками,
 * равносильна её отсутствию.
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import { apiError } from '~/kernel/errors'
import { requireFeature } from '~/domain/core/entitlements'
import { statusLabel } from '~/common/contract/order-status'
import { localized, type I18nField } from '~/common/utils/i18n-field'

/** Экранирование поля CSV: кавычки удваиваются, поле берётся в кавычки. */
function cell(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function toCsv(header: string[], rows: unknown[][]): string {
  const lines = [header.join(';'), ...rows.map((r) => r.map(cell).join(';'))]
  // ⚠️ \uFEFF (BOM) escape-последовательностью, а не самим символом:
  // невидимый символ в исходнике не виден при чтении кода — ровно тот
  // класс ошибок, от которого BOM здесь и защищает пользователя.
  // Без BOM Excel читает UTF-8 как windows-1251 и показывает крякозябры.
  return `\uFEFF${lines.join('\r\n')}\r\n`
}

export interface GetExportInput {
  query: Record<string, unknown>
}

export async function getExport(
  session: Session,
  req: GetExportInput,
  deps: Deps,
) {
  // ⚠️ Выгрузки — функция расширенного тарифа. Проверка ДО работы:
  // считать отчёт, чтобы затем отказать, значит тратить базу впустую.
  await deps.db.tx(session.tenantId, (c) =>
    requireFeature(c, session.tenantId, 'analytics'))
  const kind = String(req.query.kind ?? 'orders')

  const branchIds = session.activeRole === 'owner' || session.activeRole === 'admin'
    ? []
    : session.branchIds
  const scoped = branchIds.length > 0

  return deps.db.tx(session.tenantId, async (c) => {
    if (kind === 'orders') {
      const { rows } = await c.query<Record<string, unknown>>(
        `SELECT o.public_code, o.status,
                to_char(lower(o.period) AT TIME ZONE b.timezone, 'DD.MM.YYYY HH24:MI') AS starts_at,
                to_char(upper(o.period) AT TIME ZONE b.timezone, 'DD.MM.YYYY HH24:MI') AS ends_at,
                o.total_amount, b.name AS branch,
                cu.name AS customer,
                -- ⚠️ Телефон целиком в выгрузку НЕ идёт: файл уходит на
                -- чужой компьютер и живёт там неопределённо долго.
                -- Хвоста достаточно, чтобы сопоставить со своей записью.
                right(cu.phone, 4) AS phone_tail,
                to_char(o.created_at AT TIME ZONE b.timezone, 'DD.MM.YYYY HH24:MI') AS created_at
         FROM rental_order o
         JOIN branch b ON b.id = o.branch_pickup_id
         LEFT JOIN customer cu ON cu.id = o.customer_id
         WHERE o.tenant_id = $1 AND (NOT $2 OR o.branch_pickup_id = ANY($3::uuid[]))
         ORDER BY o.created_at DESC
         LIMIT 20000`,
        [session.tenantId, scoped, branchIds],
      )
      return toCsv(
        ['Заказ', 'Статус', 'Начало', 'Конец', 'Сумма', 'Филиал', 'Клиент', 'Телефон (хвост)', 'Создан'],
        rows.map((r) => [
          r.public_code, statusLabel(r.status as string), r.starts_at, r.ends_at,
          r.total_amount, r.branch, r.customer, r.phone_tail, r.created_at,
        ]),
      )
    }

    if (kind === 'inventory') {
      const { rows } = await c.query<Record<string, unknown>>(
        `SELECT iv.code, iv.name, cat.name AS category,
                b.name AS branch,
                COALESCE((SELECT SUM(m.qty) FROM movement m
                          WHERE m.variant_id = iv.id AND m.branch_id = iv.branch_id), 0)::int AS total
         FROM inventory_variant iv
         JOIN category cat ON cat.id = iv.category_id
         JOIN branch b ON b.id = iv.branch_id
         WHERE iv.tenant_id = $1 AND iv.archived_at IS NULL
           AND (NOT $2 OR iv.branch_id = ANY($3::uuid[]))
         ORDER BY cat.sort_order, iv.code`,
        [session.tenantId, scoped, branchIds],
      )
      return toCsv(
        ['Код', 'Название', 'Категория', 'Филиал', 'Остаток'],
        rows.map((r) => [
          r.code,
          localized(r.name as I18nField, 'ru', r.code as string),
          localized(r.category as I18nField, 'ru', ''),
          r.branch, r.total,
        ]),
      )
    }

    if (kind === 'demand') {
      // ⚠️ demand_daily обезличен и агрегирован по построению: это
      // внутренняя аналитика проката, а не данные клиентов.
      const { rows } = await c.query<Record<string, unknown>>(
        `SELECT d.day::text, iv.code AS variant, cat.name AS category,
                d.size_bucket, d.reason_code,
                d.requests, d.fulfilled, d.rejected, d.est_lost_revenue
         FROM demand_daily d
         LEFT JOIN inventory_variant iv ON iv.id = d.variant_id
         LEFT JOIN category cat ON cat.id = iv.category_id
         WHERE d.tenant_id = $1
         ORDER BY d.day DESC
         LIMIT 20000`,
        [session.tenantId],
      )
      return toCsv(
        ['Дата', 'Позиция', 'Категория', 'Размер', 'Причина отказа',
         'Запросов', 'Выполнено', 'Отказов', 'Упущено, ₽'],
        rows.map((r) => [
          r.day, r.variant,
          localized(r.category as I18nField, 'ru', ''),
          typeof r.size_bucket === 'object' ? JSON.stringify(r.size_bucket) : r.size_bucket,
          r.reason_code, r.requests, r.fulfilled, r.rejected, r.est_lost_revenue,
        ]),
      )
    }

    throw apiError('VALIDATION_FAILED', 'Неизвестный вид выгрузки')
  })
}
