/**
 * Тексты тенанта с версионированием (13.14).
 *
 * ⚠️ Редакции ДОБАВЛЯЮТСЯ, а не заменяются, и старые не удаляются
 * никогда. Причина не в аккуратности: клиент подписывает конкретную
 * редакцию, её хеш пишется в agreement, и если править текст поверх,
 * восстановить подписанное станет нечем. Спор о повреждении разбирается
 * через год, и «текст с тех пор изменился» обесценивает подпись.
 *
 * ⚠️ Ответственность за СОДЕРЖАНИЕ — тенанта, платформа даёт заготовку
 * (../rental-docs/docs/04-тз/00-общее/04-правовое.md). Поэтому здесь нет ни проверки текста
 * на юридическую годность, ни запрета сохранить пустое: мы не вправе
 * решать за прокат, что написано в его договоре.
 */
import type { PoolClient } from 'pg'
import { apiError } from '~/kernel/errors'
import { audit } from '../core/order-lifecycle'
// ⚠️ Хеш ОДИН на весь проект (server/utils/hash-text.ts): подпись доказывает
// что-то, только пока текст и его хеш считаются одинаково везде.
import { hashText } from '~/common/utils/hash-text'

export type TextKind = 'offer' | 'privacy' | 'rules'

export const TEXT_KINDS: { kind: TextKind, title: string, hint: string }[] = [
  {
    kind: 'offer',
    title: 'Договор проката (оферта)',
    hint: 'То, что подписывает клиент. Правка создаёт новую редакцию — уже подписанные договоры остаются на своей.',
  },
  {
    kind: 'privacy',
    title: 'Политика обработки персональных данных',
    hint: 'Обязательна по 152-ФЗ. Оператор данных — вы, платформа только обрабатывает их по вашему поручению.',
  },
  {
    kind: 'rules',
    title: 'Правила проката',
    hint: 'Что можно и чего нельзя со снаряжением. Не договор, но клиент видит их при бронировании.',
  },
]

export interface TextVersion {
  id: string
  kind: TextKind
  version: number
  body: string
  hash: string
  isActive: boolean
  createdAt: Date
  createdBy: string | null
}

/** История редакций одного вида, новые сверху. */
export async function listVersions(
  c: PoolClient,
  opts: { tenantId: string, kind?: TextKind },
): Promise<TextVersion[]> {
  const { rows } = await c.query<Record<string, unknown>>(
    `SELECT t.id, t.kind, t.version, t.body, t.hash, t.is_active,
            t.created_at, st.name AS created_by
     FROM tenant_text t
     LEFT JOIN staff st ON st.id = t.created_by
     WHERE t.tenant_id = $1 AND ($2::text IS NULL OR t.kind = $2)
     ORDER BY t.kind, t.version DESC`,
    [opts.tenantId, opts.kind ?? null],
  )
  return rows.map((r) => ({
    id: r.id as string,
    kind: r.kind as TextKind,
    version: r.version as number,
    body: r.body as string,
    hash: r.hash as string,
    isActive: r.is_active as boolean,
    createdAt: r.created_at as Date,
    createdBy: (r.created_by as string) ?? null,
  }))
}

/** Действующая редакция вида, или null — тогда работает заготовка платформы. */
export async function activeText(
  c: PoolClient,
  opts: { tenantId: string, kind: TextKind },
): Promise<TextVersion | null> {
  const { rows } = await c.query<Record<string, unknown>>(
    `SELECT id, kind, version, body, hash, is_active, created_at
     FROM tenant_text
     WHERE tenant_id = $1 AND kind = $2 AND is_active`,
    [opts.tenantId, opts.kind],
  )
  const r = rows[0]
  if (!r) return null
  return {
    id: r.id as string,
    kind: r.kind as TextKind,
    version: r.version as number,
    body: r.body as string,
    hash: r.hash as string,
    isActive: true,
    createdAt: r.created_at as Date,
    createdBy: null,
  }
}

/**
 * Новая редакция текста.
 *
 * ⚠️ Всегда НОВАЯ строка, даже если правка в одну запятую: смысл
 * версионирования в том, что подписанное невозможно изменить задним
 * числом. Обновление существующей редакции — ровно та операция,
 * которой здесь не должно быть.
 *
 * ⚠️ Снятие флага со старой и установка на новую — в ОДНОЙ транзакции
 * вызывающего: частичный уникальный индекс не даст двум быть
 * действующими, и без единой транзакции вторая вставка просто упадёт.
 */
export async function publishVersion(
  c: PoolClient,
  opts: {
    tenantId: string
    kind: TextKind
    body: string
    staffId: string
  },
): Promise<TextVersion> {
  const body = opts.body.trim()
  if (!body) throw apiError('VALIDATION_FAILED', 'Текст не может быть пустым')

  const { rows: prev } = await c.query<{ max: number | null, active_hash: string | null }>(
    `SELECT max(version) AS max,
            max(hash) FILTER (WHERE is_active) AS active_hash
     FROM tenant_text WHERE tenant_id = $1 AND kind = $2`,
    [opts.tenantId, opts.kind],
  )

  const hash = hashText(body)

  // ⚠️ Текст не изменился — новой редакции не создаём. Иначе нажатие
  // «сохранить» дважды плодит одинаковые версии, и история, ради
  // которой всё затевалось, становится нечитаемой.
  if (prev[0]?.active_hash === hash) {
    const current = await activeText(c, { tenantId: opts.tenantId, kind: opts.kind })
    if (current) return current
  }

  const version = (prev[0]?.max ?? 0) + 1

  await c.query(
    `UPDATE tenant_text SET is_active = false
     WHERE tenant_id = $1 AND kind = $2 AND is_active`,
    [opts.tenantId, opts.kind],
  )

  const { rows } = await c.query<Record<string, unknown>>(
    `INSERT INTO tenant_text
       (tenant_id, kind, version, body, hash, is_active, created_by)
     VALUES ($1, $2, $3, $4, $5, true, $6)
     RETURNING id, created_at`,
    [opts.tenantId, opts.kind, version, body, hash, opts.staffId],
  )

  // ⚠️ В журнал пишется ХЕШ, а не текст: оферта может быть на страницу,
  // и класть её целиком в audit_log при каждой правке — способ сделать
  // журнал нечитаемым. Текст и так лежит в своей редакции.
  await audit(c, {
    tenantId: opts.tenantId,
    staffId: opts.staffId,
    action: 'text.published',
    targetType: 'tenant_text',
    targetId: rows[0]!.id as string,
    reason: `новая редакция «${opts.kind}» №${version}`,
    after: { kind: opts.kind, version, hash },
  })

  return {
    id: rows[0]!.id as string,
    kind: opts.kind,
    version,
    body,
    hash,
    isActive: true,
    createdAt: rows[0]!.created_at as Date,
    createdBy: null,
  }
}
