/**
 * Аутентификация сотрудников: email + пароль, сессии, PIN-переключение.
 *
 * ⚠️ Email и пароль, а не SMS-код (../rental-docs/docs/04-тз/10-бэкенд/17-доступ-и-роли.md):
 * SMS требует абонентской платы за буквенное имя отправителя — около
 * 10 тыс. ₽ до первого сообщения. Вход по телефону — опция тенанта,
 * когда он готов платить.
 *
 * ⚠️ Главная особенность стойки: устройство ОБЩЕЕ, смена длинная.
 * Поэтому сессия живёт до конца дня, но действия пишутся под конкретным
 * сотрудником — PIN-переключение меняет активного сотрудника внутри
 * той же сессии. Без этого все работают под одним аккаунтом, и лог
 * «кто выставил DIN» становится бесполезным, а это след ответственности.
 *
 * Хеширование — scrypt из node:crypto: он в стандартной библиотеке,
 * рекомендован для паролей и не тянет зависимость, которую придётся
 * обновлять из-за уязвимостей.
 */
import { randomBytes, createHash, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import type { PoolClient } from 'pg'
import { getWorkerPool } from '~/kernel/db'
// ⚠️ Роль объявлена в shared/permissions.ts — там же, где права,
// чтобы список ролей и матрица не разъехались.
import type { StaffRole } from '~/common/contract/permissions'

const scryptAsync = promisify(scrypt) as (
  password: string, salt: Buffer, keylen: number,
) => Promise<Buffer>

export type { StaffRole }

/** Сколько живёт сессия стойки: до конца рабочего дня с запасом. */
const SESSION_TTL_MS = 16 * 3600 * 1000

/** После скольких неудачных попыток аккаунт блокируется. */
const MAX_FAILED_ATTEMPTS = 10

/** Окно, в котором считаются неудачные попытки. */
const ATTEMPT_WINDOW_MINUTES = 15

/* ───────────────────────── пароли ───────────────────────── */

/**
 * Хеш пароля в формате `scrypt$<соль в hex>$<ключ в hex>`.
 *
 * Соль на каждый пароль своя: одинаковые пароли не должны давать
 * одинаковые хеши, иначе видно, у кого пароли совпадают.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scryptAsync(password, salt, 64)
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`
}

/**
 * Проверка пароля.
 *
 * ⚠️ timingSafeEqual, а не ===: сравнение строк выходит на первом
 * различии, и по времени ответа можно подбирать хеш посимвольно.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, keyHex] = stored.split('$')
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false

  const salt = Buffer.from(saltHex, 'hex')
  const expected = Buffer.from(keyHex, 'hex')
  const actual = await scryptAsync(password, salt, expected.length)

  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/* ───────────────────────── вход ───────────────────────── */

export interface Session {
  sessionId: string
  tenantId: string
  /** Владелец сессии — тот, кто вводил пароль. */
  staffId: string
  /** Кто работает сейчас: меняется PIN-переключением. */
  activeStaffId: string
  activeRole: StaffRole
  activeName: string
  branchIds: string[]
}

export type LoginResult =
  | { ok: true, token: string, session: Session }
  | { ok: false, reason: 'invalid_credentials' | 'locked' | 'too_many_attempts' }

/**
 * Вход по email и паролю.
 *
 * ⚠️ Идёт под ролью воркера (BYPASSRLS), потому что тенант на момент
 * входа НЕИЗВЕСТЕН: сотрудник вводит только email и пароль. Это второй
 * законный случай работы вне тенантного контекста после поиска заказа
 * по токену.
 *
 * ⚠️ «Неверный email» и «неверный пароль» дают ОДИН ответ: иначе
 * перебором выясняется список сотрудников.
 */
export async function login(opts: {
  email: string
  password: string
  ip?: string
  userAgent?: string
}): Promise<LoginResult> {
  const pool = getWorkerPool()
  const email = opts.email.trim().toLowerCase()

  // Защита от подбора: считаем неудачи по email за окно.
  const { rows: attempts } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM staff_login_attempt
     WHERE email = $1 AND NOT succeeded
       AND occurred_at > now() - ($2 || ' minutes')::interval`,
    [email, ATTEMPT_WINDOW_MINUTES],
  )
  if ((attempts[0]?.n ?? 0) >= MAX_FAILED_ATTEMPTS) {
    return { ok: false, reason: 'too_many_attempts' }
  }

  const { rows } = await pool.query<{
    id: string
    tenant_id: string
    password_hash: string | null
    role: StaffRole
    name: string
    branch_ids: string[] | null
    locked_at: Date | null
  }>(
    `SELECT id, tenant_id, password_hash, role, name, branch_ids, locked_at
     FROM staff
     WHERE lower(email) = $1 AND archived_at IS NULL`,
    [email],
  )
  const staff = rows[0]

  const record = async (succeeded: boolean, tenantId?: string) => {
    await pool.query(
      `INSERT INTO staff_login_attempt (tenant_id, email, ip, succeeded)
       VALUES ($1, $2, $3, $4)`,
      [tenantId ?? null, email, opts.ip ?? null, succeeded],
    )
  }

  if (!staff?.password_hash) {
    await record(false)
    return { ok: false, reason: 'invalid_credentials' }
  }

  if (staff.locked_at) {
    await record(false, staff.tenant_id)
    return { ok: false, reason: 'locked' }
  }

  if (!await verifyPassword(opts.password, staff.password_hash)) {
    await record(false, staff.tenant_id)
    return { ok: false, reason: 'invalid_credentials' }
  }

  const token = randomBytes(32).toString('base64url')
  const { rows: created } = await pool.query<{ id: string }>(
    `INSERT INTO staff_session
       (tenant_id, staff_id, token_hash, active_staff_id, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $2, $4, $5, now() + ($6 || ' milliseconds')::interval)
     RETURNING id`,
    [staff.tenant_id, staff.id, hashToken(token),
     opts.ip ?? null, opts.userAgent ?? null, SESSION_TTL_MS],
  )

  await record(true, staff.tenant_id)

  return {
    ok: true,
    token,
    session: {
      sessionId: created[0]!.id,
      tenantId: staff.tenant_id,
      staffId: staff.id,
      activeStaffId: staff.id,
      activeRole: staff.role,
      activeName: staff.name,
      branchIds: staff.branch_ids ?? [],
    },
  }
}

/**
 * Разбирает токен сессии.
 *
 * ⚠️ Возвращает АКТИВНОГО сотрудника, а не владельца сессии: после
 * PIN-переключения действия должны логироваться под тем, кто реально
 * работает.
 */
export async function resolveSession(token: string): Promise<Session | null> {
  if (!token || token.length < 20) return null

  const { rows } = await getWorkerPool().query<{
    id: string
    tenant_id: string
    staff_id: string
    active_staff_id: string
    role: StaffRole
    name: string
    branch_ids: string[] | null
  }>(
    `SELECT s.id, s.tenant_id, s.staff_id, s.active_staff_id,
            a.role, a.name, a.branch_ids
     FROM staff_session s
     JOIN staff a ON a.id = s.active_staff_id
     WHERE s.token_hash = $1
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
       AND a.archived_at IS NULL`,
    [hashToken(token)],
  )
  const r = rows[0]
  if (!r) return null

  return {
    sessionId: r.id,
    tenantId: r.tenant_id,
    staffId: r.staff_id,
    activeStaffId: r.active_staff_id,
    activeRole: r.role,
    activeName: r.name,
    branchIds: r.branch_ids ?? [],
  }
}

/**
 * Быстрое переключение сотрудника по PIN — без полного входа.
 *
 * ⚠️ Ради этого и существует разделение staff_id / active_staff_id.
 * На стойке в пик никто не будет вводить email и пароль между
 * клиентами: если переключение неудобно, все работают под одним
 * аккаунтом, и запись «кто проверил DIN» перестаёт что-то значить.
 *
 * Переключиться можно только на сотрудника ТОГО ЖЕ тенанта.
 */
export async function switchByPin(
  sessionToken: string,
  pin: string,
): Promise<Session | null> {
  const session = await resolveSession(sessionToken)
  if (!session) return null

  const pool = getWorkerPool()
  const { rows } = await pool.query<{
    id: string
    pin_hash: string | null
    role: StaffRole
    name: string
    branch_ids: string[] | null
  }>(
    `SELECT id, pin_hash, role, name, branch_ids
     FROM staff
     WHERE tenant_id = $1 AND archived_at IS NULL
       AND locked_at IS NULL AND pin_hash IS NOT NULL`,
    [session.tenantId],
  )

  // PIN короткий, поэтому проверяем перебором по сотрудникам тенанта:
  // индекса по PIN быть не может, а список сотрудников проката мал.
  for (const s of rows) {
    if (s.pin_hash && await verifyPassword(pin, s.pin_hash)) {
      await pool.query(
        `UPDATE staff_session SET active_staff_id = $2 WHERE id = $1`,
        [session.sessionId, s.id],
      )
      return {
        ...session,
        activeStaffId: s.id,
        activeRole: s.role,
        activeName: s.name,
        branchIds: s.branch_ids ?? [],
      }
    }
  }

  return null
}

export async function logout(token: string): Promise<void> {
  await getWorkerPool().query(
    `UPDATE staff_session SET revoked_at = now()
     WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hashToken(token)],
  )
}

/* ───────────────────────── полномочия ───────────────────────── */

/**
 * ⚠️ Матрица прав живёт в `shared/permissions.ts` — одна на фронт и бэк.
 * Здесь только реэкспорт: раньше она была скопирована в
 * `app/composables/useStaff.ts` с пометкой «зеркало», и две копии
 * разошлись бы на первой правке. Расхождение это либо пункт меню,
 * ведущий в 403, либо спрятанный экран, к которому доступ есть.
 */
export {
  type Permission,
  PERMISSION_GROUPS,
  PERMISSION_LABELS,
  ROLE_PERMISSIONS,
} from '~/common/contract/permissions'

export { roleCan as can } from '~/common/contract/permissions'


/**
 * Доступен ли филиал сотруднику.
 *
 * ⚠️ RLS изолирует тенантов, но внутри тенанта нужна вторая граница:
 * иначе сотрудник одной точки видит заказы, выручку и персональные
 * данные клиентов всей сети — это и беспорядок, и нарушение 152-ФЗ
 * (доступ к ПД без необходимости).
 *
 * Владелец и администратор — все филиалы тенанта, поэтому у них
 * branch_ids обычно пуст.
 */
export function canAccessBranch(session: Session, branchId: string): boolean {
  if (session.activeRole === 'owner' || session.activeRole === 'admin') return true
  return session.branchIds.includes(branchId)
}

/** Ставит блокировку. Снимает только владелец — см. миграцию 0008. */
export async function lockStaff(
  c: PoolClient,
  opts: { staffId: string, reason: string },
): Promise<void> {
  await c.query(
    `UPDATE staff SET locked_at = now(), locked_reason = $2 WHERE id = $1`,
    [opts.staffId, opts.reason],
  )
}
