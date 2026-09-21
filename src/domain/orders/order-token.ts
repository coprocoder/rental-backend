/**
 * Токены доступа клиента к заказу.
 *
 * Клиент не регистрируется — доступ даётся ссылкой из уведомления.
 * Требования из ТЗ (../rental-docs/docs/04-тз/10-бэкенд/17-доступ-и-роли.md):
 *
 *   токен длинный и случайный, НЕ производный от id заказа — иначе
 *   перебором читаются чужие заказы;
 *   разный токен на каждую цель: утечка ссылки «посмотреть» не должна
 *   давать возможность отменить;
 *   живёт до конца аренды плюс 30 дней;
 *   подтверждение идемпотентно — люди жмут дважды, и второе нажатие
 *   означает «уже подтверждено», а не ошибку.
 *
 * ⚠️ В БД лежит только sha256 от токена. Сам токен существует в ссылке
 * и больше нигде: дамп базы не должен открывать заказы клиентов.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { PoolClient } from 'pg'

export type TokenPurpose = 'view' | 'confirm' | 'cancel'

/** Сколько ссылка живёт после окончания аренды. */
const TTL_AFTER_END_MS = 30 * 24 * 3600 * 1000

/**
 * 32 байта энтропии в base64url — 256 бит.
 *
 * ⚠️ randomBytes, а не Math.random: предсказуемый токен равносилен
 * отсутствию токена.
 */
function generate(): string {
  return randomBytes(32).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Выдаёт по одному токену на каждую цель и возвращает сами токены —
 * вызывающий кладёт их в ссылки. Повторно их получить нельзя.
 */
export async function issueOrderTokens(
  c: PoolClient,
  opts: { tenantId: string, orderId: string, rentalEnd: Date },
): Promise<Record<TokenPurpose, string>> {
  const purposes: TokenPurpose[] = ['view', 'confirm', 'cancel']
  const expiresAt = new Date(opts.rentalEnd.getTime() + TTL_AFTER_END_MS)
  const out = {} as Record<TokenPurpose, string>

  for (const purpose of purposes) {
    const token = generate()
    out[purpose] = token
    await c.query(
      `INSERT INTO order_token (tenant_id, order_id, purpose, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [opts.tenantId, opts.orderId, purpose, hashToken(token), expiresAt],
    )
  }

  return out
}

/**
 * Находит тенанта и заказ по токену БЕЗ контекста RLS.
 *
 * ⚠️ Нужно потому, что тенант определяется самим токеном: до его
 * разбора неизвестно, какой app.tenant_id выставлять. Это единственное
 * место, где чтение идёт вне тенантного контекста, и оно возвращает
 * только идентификаторы — никаких данных заказа.
 *
 * ⚠️ Хеш считается в Node, а не в SQL: иначе сам токен попадает в
 * текст запроса и оседает в логах Postgres.
 */
export async function locateByToken(
  c: PoolClient,
  token: string,
  purpose: TokenPurpose,
): Promise<{ tenantId: string, orderId: string } | null> {
  // Длина отсекает мусор до обращения к БД.
  if (!token || token.length < 20) return null

  const hash = hashToken(token)

  // ⚠️ Политика order_token_lookup_by_hash показывает строку только
  // тому, кто назвал её хеш. SET LOCAL — значение живёт до конца
  // транзакции и не протекает в соседние запросы из пула.
  await c.query(`SELECT set_config('app.token_hash', $1, true)`, [hash])

  const { rows } = await c.query<{ tenant_id: string, order_id: string }>(
    `SELECT tenant_id, order_id FROM order_token
     WHERE token_hash = $1 AND purpose = $2 AND expires_at > now()`,
    [hash, purpose],
  )
  const hit = rows[0]
  return hit ? { tenantId: hit.tenant_id, orderId: hit.order_id } : null
}

export interface ResolvedToken {
  orderId: string
  purpose: TokenPurpose
  /** Уже использован: для confirm это не ошибка, а «повторное нажатие». */
  usedAt: Date | null
}

/**
 * Находит заказ по токену.
 *
 * Возвращает null и для неизвестного, и для истёкшего токена: клиенту
 * незачем знать, какой из случаев — это подсказка перебирающему.
 */
export async function resolveToken(
  c: PoolClient,
  token: string,
  purpose: TokenPurpose,
): Promise<ResolvedToken | null> {
  const { rows } = await c.query<{
    order_id: string
    purpose: TokenPurpose
    used_at: Date | null
  }>(
    `SELECT order_id, purpose, used_at
     FROM order_token
     WHERE token_hash = $1 AND purpose = $2 AND expires_at > now()`,
    [hashToken(token), purpose],
  )

  const row = rows[0]
  if (!row) return null
  return { orderId: row.order_id, purpose: row.purpose, usedAt: row.used_at }
}

/** Отмечает токен использованным. Для confirm — след идемпотентности. */
export async function markTokenUsed(
  c: PoolClient,
  token: string,
  purpose: TokenPurpose,
): Promise<void> {
  await c.query(
    `UPDATE order_token SET used_at = now()
     WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL`,
    [hashToken(token), purpose],
  )
}
