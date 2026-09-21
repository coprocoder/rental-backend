/**
 * Лист ожидания: отказ превращается в контакт.
 *
 * Проблема из ТЗ (../rental-docs/docs/04-тз/10-бэкенд/22-лист-ожидания.md): при отсутствии
 * наличия бронь просто не создаётся, клиент видит «занято» и уходит.
 * А инвентарь регулярно освобождается — отмены, досрочные возвраты,
 * снятые по дедлайну брони. Освободившееся некому предложить.
 *
 * ⚠️ Запись НЕ блокирует инвентарь: в отличие от брони, она ничего не
 * удерживает. Поэтому листом ожидания нельзя захватить арсенал — и
 * поэтому же он не требует дедлайнов и лимитов.
 *
 * ⚠️ Законность (публичный договор, ГК ст. 626 п. 3 — равные условия):
 *   очередь строго по времени записи, объективный критерий;
 *   НЕЛЬЗЯ пропускать вперёд за деньги, подписку или «постоянным
 *   клиентам» — это преимущество по неравному условию;
 *   НЕЛЬЗЯ делать лист платным;
 *   окно на реакцию одинаково для всех.
 * То есть механика работает только как честная очередь — что вдобавок
 * проще в реализации.
 *
 * Главная ценность не в выручке с освободившегося, а в данных: без
 * листа отказ не оставляет следа, и прокат не знает, чего ему не
 * хватает (../rental-docs/docs/04-тз/10-бэкенд/23-прогноз-закупки.md).
 *
 * ── Развитие 17.14 ───────────────────────────────────────────────────
 *
 * ⚠️ Предложение уходит СРАЗУ НЕСКОЛЬКИМ, с гонкой за позицию. В v1
 * приглашали строго первого, и до второго очередь доходила только
 * через 45 минут молчания: на пиковой субботе позиция простаивала
 * три четверти часа из-за одного человека, не посмотревшего телефон.
 *
 * Честность очереди при этом сохраняется: приглашают первых N строго
 * по времени записи, окно на реакцию у всех одинаковое, «вперёд за
 * деньги» по-прежнему нет. Меняется размер окна приглашения, а не
 * критерий отбора — публичный договор (ГК ст. 626 п. 3) требует
 * равных условий, а не одного адресата.
 *
 * ⚠️ Победителя определяет БД (уникальный индекс на release_key),
 * а не порядок операций в коде: иначе два откликнувшихся одновременно
 * оба получат «ваша позиция свободна» (железное правило №2).
 *
 * ⚠️ Проигравшему говорим честно: «позицию забрали, вы остаётесь
 * в очереди». Молчание здесь хуже отказа — человек пришёл по ссылке
 * и должен понимать, что произошло.
 */
import { randomBytes } from 'node:crypto'
import type { PoolClient } from 'pg'
import { hashText } from '~/common/utils/hash-text'
import { enqueue } from '../core/outbox'

/** Сколько времени даётся на реакцию. Ориентир ТЗ — 30–60 минут. */
export const REACTION_WINDOW_MINUTES = 45

/**
 * Скольким предлагать одновременно.
 *
 * ⚠️ Не «всем»: приглашение — это обещание, и раздать его двадцати
 * значит девятнадцать раз обмануть. Трое — компромисс между простоем
 * позиции и долей тех, кто придёт к разобранному.
 */
export const OFFER_BATCH = 3

export interface WaitlistEntry {
  id: string
  variantId: string
  customerId: string
  /** Токен предложения. Есть только сразу после приглашения. */
  offerToken?: string
}

/**
 * Записывает клиента в лист ожидания.
 *
 * Запись живёт до начала желаемого интервала: после него она
 * бессмысленна и истекает сама.
 */
export async function addToWaitlist(
  c: PoolClient,
  opts: {
    tenantId: string
    branchId: string
    variantId: string
    customerId: string
    from: Date
    to: Date
    /**
     * «Любая дата в диапазоне» (17.14): границы, в которых клиент
     * согласен взять снаряжение. Без них ждём ровно [from, to).
     */
    searchFrom?: Date
    searchTo?: Date
  },
): Promise<string> {
  // ⚠️ Диапазон поиска обязан покрывать желаемый интервал — иначе
  // искомое в него не помещается. В БД это CHECK, здесь — понятная
  // ошибка вместо нарушения ограничения.
  const searchFrom = opts.searchFrom ?? null
  const searchTo = opts.searchTo ?? null
  if (searchFrom && searchTo
    && (searchFrom > opts.from || searchTo < opts.to)) {
    throw new Error('Диапазон поиска уже желаемого интервала')
  }

  // Длительность в сутках: по ней подбирается окно внутри диапазона.
  const nights = Math.max(
    1,
    Math.round((opts.to.getTime() - opts.from.getTime()) / 86_400_000),
  )

  // ⚠️ Запись живёт до конца ДИАПАЗОНА ПОИСКА, а не до начала желаемых
  // дат: тому, кто готов взять снаряжение когда угодно на новогодних,
  // в первый же день ждать не перестало. Без диапазона — прежнее
  // поведение, до начала интервала.
  const expiresAt = searchTo ?? opts.from

  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO waitlist
       (tenant_id, branch_id, variant_id, customer_id, period, expires_at,
        search_period, nights)
     VALUES ($1, $2, $3, $4, tstzrange($5, $6), $7,
             CASE WHEN $8::timestamptz IS NULL THEN NULL
                  ELSE tstzrange($8, $9) END,
             $10)
     RETURNING id`,
    [opts.tenantId, opts.branchId, opts.variantId, opts.customerId,
     opts.from, opts.to, expiresAt, searchFrom, searchTo, nights],
  )
  return rows[0]!.id
}

/**
 * Предлагает освободившийся инвентарь первым в очереди.
 *
 * Вызывается при КАЖДОМ освобождении: отмена, досрочный возврат,
 * снятие по дедлайну. Срабатывание идёт через журнал событий, а не
 * прямым вызовом из обработчика отмены — иначе каждый новый способ
 * освободить инвентарь пришлось бы не забыть подключить.
 *
 * ⚠️ ORDER BY created_at без исключений: это и есть честная очередь.
 * Любая добавка вида «сначала постоянным клиентам» делает механику
 * незаконной.
 *
 * ⚠️ Приглашают НЕСКОЛЬКИХ (17.14), но всех — за одно и то же
 * освобождение, с одним release_key. Забрать сможет ровно один:
 * это решает уникальный индекс, см. claimOffer. Очередь при этом
 * не нарушена — берутся первые OFFER_BATCH строго по created_at,
 * окно на реакцию у всех одинаковое.
 *
 * ⚠️ Подходит и запись «любая дата в диапазоне»: у неё пересечение
 * проверяется по search_period, а не по period. Строка без диапазона
 * ведёт себя как раньше — COALESCE сводит оба случая к одному условию.
 */
export async function offerToNextInQueue(
  c: PoolClient,
  opts: {
    tenantId: string
    variantId: string
    /** Интервал, который освободился. */
    from: Date
    to: Date
    correlationId?: string
    /** Скольким предложить. По умолчанию OFFER_BATCH. */
    batch?: number
  },
): Promise<WaitlistEntry[]> {
  const batch = opts.batch ?? OFFER_BATCH

  /**
   * Ключ гонки — это конкретное освобождение.
   *
   * ⚠️ Детерминированный, а не случайный: одно и то же освобождение
   * может прийти повторно (повтор события, ретрай обработчика), и
   * случайный ключ открыл бы вторую гонку за уже занятую позицию.
   */
  const releaseKey = `${opts.variantId}:${opts.from.toISOString()}:${opts.to.toISOString()}`

  const { rows } = await c.query<{
    id: string
    variant_id: string
    customer_id: string
    variant_name: { ru?: string }
  }>(
    `SELECT w.id, w.variant_id, w.customer_id, v.name AS variant_name
     FROM waitlist w
     JOIN inventory_variant v ON v.id = w.variant_id
     WHERE w.tenant_id = $1
       AND w.variant_id = $2
       AND w.status = 'waiting'
       AND w.expires_at > now()
       -- Освободившийся интервал должен пересекаться с тем, где клиент
       -- согласен взять: у обычной записи это желаемые даты, у записи
       -- «любая дата в диапазоне» — весь диапазон поиска.
       AND COALESCE(w.search_period, w.period) && tstzrange($3, $4)
       -- ⚠️ Длительность обязана поместиться в освободившееся окно:
       -- предлагать двое суток тому, у кого освободились одни, —
       -- это приглашение к разочарованию на стойке.
       AND COALESCE(w.nights, 1) <= GREATEST(1, EXTRACT(EPOCH FROM ($4::timestamptz - $3::timestamptz)) / 86400)
     ORDER BY w.created_at
     LIMIT $5
     FOR UPDATE SKIP LOCKED`,
    [opts.tenantId, opts.variantId, opts.from, opts.to, batch],
  )

  if (rows.length === 0) return []

  const out: WaitlistEntry[] = []

  for (const entry of rows) {
    // ⚠️ Токен на каждое предложение свой: ссылка одного не должна
    // забирать позицию за другого. В БД уходит только хеш.
    const token = randomBytes(32).toString('base64url')

    await c.query(
      `UPDATE waitlist
       SET status = 'offered',
           notified_at = now(),
           release_key = $2,
           offer_token_hash = $3
       WHERE id = $1`,
      [entry.id, releaseKey, hashText(token)],
    )

    // Уведомление — через outbox: отправка не должна идти из транзакции,
    // меняющей состояние (железное правило про outbox).
    await enqueue(c, {
      tenantId: opts.tenantId,
      kind: 'waitlist.available',
      payload: {
        waitlistId: entry.id,
        variantId: entry.variant_id,
        variantName: entry.variant_name?.ru ?? 'Позиция',
        reactionMinutes: REACTION_WINDOW_MINUTES,
        // ⚠️ Токен уходит в письмо и больше нигде не появляется.
        offerToken: token,
        // ⚠️ Честно предупреждаем, что предложение не единственное:
        // человек, приехавший к разобранному, должен был знать заранее.
        // Умолчание здесь дороже, чем упущенная позиция.
        contested: rows.length > 1,
        from: opts.from.toISOString(),
        to: opts.to.toISOString(),
      },
      // ⚠️ Ключ включает время предложения: одну и ту же запись можно
      // предложить повторно, если первый не отреагировал и очередь
      // вернулась к ней. Ключ без времени схлопнул бы второе письмо.
      idempotencyKey: `waitlist:${entry.id}:${Date.now()}`,
      correlationId: opts.correlationId,
    })

    out.push({
      id: entry.id,
      variantId: entry.variant_id,
      customerId: entry.customer_id,
      offerToken: token,
    })
  }

  return out
}

/** Чем закончилась попытка забрать предложение. */
export type ClaimOutcome =
  | { ok: true, entry: WaitlistEntry }
  /** Позицию успел забрать другой из приглашённых. */
  | { ok: false, reason: 'taken' }
  /** Окно на реакцию вышло, предложение ушло дальше по очереди. */
  | { ok: false, reason: 'expired' }
  /** Токен не подошёл: чужая или несуществующая ссылка. */
  | { ok: false, reason: 'unknown' }

/**
 * Забирает предложенную позицию по токену из письма.
 *
 * ⚠️ Победителя определяет БД, а не этот код. Уникальный индекс
 * `waitlist_one_winner_uk` (tenant_id, release_key) WHERE claimed_at
 * IS NOT NULL допускает ровно одну забранную строку на освобождение;
 * второй одновременный вызов получает 23505 и честный отказ. Проверка
 * «уже занято?» перед записью гонку НЕ закрывает: оба обработчика
 * прочитали бы «свободно» (железное правило №2).
 *
 * ⚠️ Отказ здесь — не ошибка, а нормальный исход, и он должен быть
 * различим: «забрали» и «время вышло» — разные сообщения человеку.
 * Молчание хуже отказа: он пришёл по ссылке и должен понять, что
 * произошло.
 */
export async function claimOffer(
  c: PoolClient,
  token: string,
): Promise<ClaimOutcome> {
  const { rows } = await c.query<{
    id: string
    variant_id: string
    customer_id: string
    status: string
    expired: boolean
  }>(
    `SELECT id, variant_id, customer_id, status,
            (notified_at + ($2 || ' minutes')::interval <= now()) AS expired
     FROM waitlist
     WHERE offer_token_hash = $1`,
    [hashText(token), REACTION_WINDOW_MINUTES],
  )

  const entry = rows[0]
  if (!entry) return { ok: false, reason: 'unknown' }
  if (entry.status !== 'offered') {
    // Строку уже увели дальше по очереди или клиент забрал её сам.
    return { ok: false, reason: entry.status === 'claimed' ? 'taken' : 'expired' }
  }
  if (entry.expired) return { ok: false, reason: 'expired' }

  try {
    await c.query(
      `UPDATE waitlist SET status = 'claimed', claimed_at = now() WHERE id = $1`,
      [entry.id],
    )
  } catch (e) {
    // 23505 — уникальный индекс: за это освобождение уже взял другой.
    if ((e as { code?: string }).code === '23505') return { ok: false, reason: 'taken' }
    throw e
  }

  return {
    ok: true,
    entry: { id: entry.id, variantId: entry.variant_id, customerId: entry.customer_id },
  }
}

/**
 * Передаёт предложение следующим, если приглашённые не отреагировали.
 *
 * Вызывается фоновым процессом. Записи, где окно вышло, помечаются
 * пропущенными, и предложение уходит дальше по очереди.
 *
 * ⚠️ Освобождение обрабатывается ОДИН раз на группу, а не по строке.
 * Приглашали троих — истекут тоже трое, и наивный цикл позвал бы
 * следующую тройку трижды, раздав девять приглашений на одну позицию.
 * Дедупликация по release_key.
 *
 * ⚠️ Уже забранное освобождение (claimed) не переигрывается: победитель
 * есть, предлагать больше нечего.
 */
export async function passExpiredOffers(
  c: PoolClient,
  limit = 50,
): Promise<number> {
  const { rows } = await c.query<{
    id: string
    tenant_id: string
    variant_id: string
    release_key: string | null
    lower: Date
    upper: Date
  }>(
    `UPDATE waitlist
     SET status = 'skipped'
     WHERE id IN (
       SELECT id FROM waitlist
       WHERE status = 'offered'
         AND notified_at + ($1 || ' minutes')::interval <= now()
       ORDER BY notified_at
       LIMIT $2
     )
     RETURNING id, tenant_id, variant_id, release_key,
               lower(period) AS lower, upper(period) AS upper`,
    [REACTION_WINDOW_MINUTES, limit],
  )

  // ⚠️ Одна следующая группа на одно освобождение, а не на строку.
  const seen = new Set<string>()
  for (const r of rows) {
    const key = r.release_key ?? `${r.variant_id}:${r.lower}:${r.upper}`
    if (seen.has(key)) continue
    seen.add(key)

    // Позицию мог забрать кто-то из этой же группы: тогда истёкшие
    // строки — просто проигравшие, и звать следующих не за чем.
    const { rows: won } = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM waitlist
       WHERE tenant_id = $1 AND release_key = $2 AND claimed_at IS NOT NULL`,
      [r.tenant_id, key],
    )
    if (Number(won[0]?.n ?? 0) > 0) continue

    await offerToNextInQueue(c, {
      tenantId: r.tenant_id,
      variantId: r.variant_id,
      from: r.lower,
      to: r.upper,
    })
  }

  return rows.length
}

/**
 * Истекает записи, у которых начался желаемый интервал.
 *
 * Ждать дальше нечего: аренда уже должна была начаться.
 */
export async function expireWaitlist(c: PoolClient, limit = 200): Promise<number> {
  const { rows } = await c.query<{ id: string }>(
    `UPDATE waitlist
     SET status = 'expired'
     WHERE id IN (
       SELECT id FROM waitlist
       WHERE status IN ('waiting', 'offered') AND expires_at <= now()
       LIMIT $1
     )
     RETURNING id`,
    [limit],
  )
  return rows.length
}
