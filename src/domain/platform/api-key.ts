/**
 * Ключи API: публичный для виджета, секретный для сервера.
 *
 * Роль в защите продукта (../rental-docs/docs/04-тз/00-общее/06-защита-продукта.md по смыслу и
 * разбор в плане): JS-бандл защитить нельзя — он исполняется в
 * браузере. Но скопировав бандл, человек получает мёртвую оболочку:
 * наличие, подбор, расчёт цены и создание броней живут на сервере,
 * а сервер отвечает только по ключу действующей подписки.
 *
 * ⚠️ Разделение ключей обязательно:
 *   pk_ — в вёрстке, только чтение каталога и расчёт;
 *   sk_ — только сервер, создание броней и вебхуки.
 * Секретный ключ НИКОГДА не попадает в браузер.
 *
 * ⚠️ Привязка к origin слабая против скрипта (заголовки подделываются
 * вне браузера), но достаточная против ровно того сценария, который
 * беспокоит: чтобы виджет работал у посетителей чужого сайта, он
 * должен ходить из браузера с их домена — а этот домен в списке не
 * значится.
 *
 * ⚠️ В БД лежит только хеш: дамп базы не должен давать доступ к API
 * тенантов.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { PoolClient } from 'pg'
import { apiError } from '~/kernel/errors'

export type KeyKind = 'public' | 'secret'

export interface ResolvedKey {
  tenantId: string
  kind: KeyKind
  origins: string[] | null
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

/**
 * Создаёт ключ и возвращает его ОДИН раз.
 *
 * Показать повторно невозможно: в базе только хеш. Это неудобно и
 * сделано намеренно — потерянный ключ отзывается и выдаётся новый.
 */
export async function issueApiKey(
  c: PoolClient,
  opts: { tenantId: string, kind: KeyKind, origins?: string[] },
): Promise<{ key: string, id: string }> {
  const prefix = opts.kind === 'public' ? 'pk' : 'sk'
  const secret = randomBytes(24).toString('base64url')
  const key = `${prefix}_${secret}`

  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO api_key (tenant_id, prefix, hash, origins)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [
      opts.tenantId,
      prefix,
      hashKey(key),
      // ⚠️ Origins только у публичного ключа: у секретного их не
      // бывает, потому что он используется сервер-сервер, где
      // заголовка Origin нет вовсе.
      opts.kind === 'public' ? (opts.origins ?? null) : null,
    ],
  )

  return { key, id: rows[0]!.id }
}

/**
 * Разбирает ключ из запроса.
 *
 * ⚠️ Ищется под ролью воркера, потому что тенант определяется самим
 * ключом — как и с токеном заказа. Третий и последний законный случай
 * работы вне тенантного контекста.
 */
export async function resolveApiKey(
  c: PoolClient,
  key: string,
): Promise<ResolvedKey | null> {
  if (!key || key.length < 10) return null

  const prefix = key.startsWith('pk_') ? 'pk' : key.startsWith('sk_') ? 'sk' : null
  if (!prefix) return null

  const { rows } = await c.query<{
    tenant_id: string
    hash: string
    origins: string[] | null
  }>(
    `SELECT tenant_id, hash, origins FROM api_key
     WHERE prefix = $1 AND revoked_at IS NULL`,
    [prefix],
  )

  const target = Buffer.from(hashKey(key), 'hex')
  for (const row of rows) {
    const candidate = Buffer.from(row.hash, 'hex')
    // ⚠️ timingSafeEqual: сравнение строк выходит на первом различии,
    // и по времени ответа ключ подбирается посимвольно.
    if (candidate.length === target.length && timingSafeEqual(candidate, target)) {
      return {
        tenantId: row.tenant_id,
        kind: prefix === 'pk' ? 'public' : 'secret',
        origins: row.origins,
      }
    }
  }

  return null
}

/**
 * Проверяет Origin запроса против списка ключа.
 *
 * Пустой список означает «любой источник» — так удобно начинать, но
 * тенанту в админке об этом говорится прямо.
 */
export function originAllowed(resolved: ResolvedKey, origin: string | undefined): boolean {
  if (resolved.kind === 'secret') return true
  if (!resolved.origins?.length) return true
  if (!origin) return false

  let host: string
  try {
    host = new URL(origin).host
  } catch {
    return false
  }

  return resolved.origins.some((allowed) => {
    const pattern = allowed.trim().toLowerCase()
    if (!pattern) return false
    // Поддомены через *.example.com — сети нужны свои домены филиалов.
    if (pattern.startsWith('*.')) {
      const base = pattern.slice(2)
      return host === base || host.endsWith(`.${base}`)
    }
    return host === pattern
  })
}

/**
 * Требует действующий ключ нужного вида.
 *
 * ⚠️ Один и тот же ответ на «нет такого ключа» и «ключ отозван»:
 * различие подсказывало бы, что ключ угадан верно.
 */
export function assertKey(
  resolved: ResolvedKey | null,
  opts: { kind?: KeyKind, origin?: string },
): ResolvedKey {
  if (!resolved) throw apiError('FORBIDDEN', 'Ключ недействителен')

  if (opts.kind && resolved.kind !== opts.kind) {
    throw apiError(
      'FORBIDDEN',
      resolved.kind === 'public'
        ? 'Это действие требует секретного ключа'
        : 'Секретный ключ не используется из браузера',
    )
  }

  if (!originAllowed(resolved, opts.origin)) {
    throw apiError('FORBIDDEN', 'Домен не разрешён для этого ключа', {
      origin: opts.origin ?? null,
    })
  }

  return resolved
}

/** Отзыв ключа. Восстановить нельзя — выдаётся новый. */
export async function revokeApiKey(
  c: PoolClient,
  opts: { tenantId: string, keyId: string },
): Promise<void> {
  await c.query(
    `UPDATE api_key SET revoked_at = now()
     WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL`,
    [opts.keyId, opts.tenantId],
  )
}
