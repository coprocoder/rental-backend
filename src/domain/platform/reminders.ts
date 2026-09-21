/**
 * Напоминания подтвердить бронь (20.4).
 *
 * ⚠️ Зачем вообще: напоминание само по себе, без депозита и предоплаты,
 * снижает неявки примерно на 16% — самое дешёвое из всего, что показал
 * разбор смежных отраслей (../rental-docs/docs/05-работы/TODO.md,
 * пункт 20.4). Обработчик `order.confirm_reminder` и шаблоны на трёх
 * каналах уже существовали; не хватало ровно этого — того, кто ставит
 * задачу в очередь.
 *
 * ⚠️ Два окна, а не одно: за 48 часов человек ещё успевает передумать
 * и освободить инвентарь заранее, за 12 — это последний шанс до
 * автоснятия. Ключи идемпотентности разные, поэтому оба срабатывают
 * по одному разу каждое.
 *
 * ⚠️ Идемпотентность держится уникальным индексом
 * (tenant_id, idempotency_key) и ON CONFLICT DO NOTHING внутри enqueue,
 * а НЕ отметкой в коде. Воркер крутится раз в 15 секунд: любая защита
 * «проверили и записали» здесь проигрывает гонку сама себе.
 */
import type { PoolClient } from 'pg'
import { enqueue } from '../core/outbox'
import { issueOrderTokens } from '../orders/order-token'

/**
 * Окна напоминаний: часов до дедлайна подтверждения.
 *
 * ⚠️ Окна НЕ ВЛОЖЕНЫ, а идут встык: 48–12 и 12–0. Пока верхнее было
 * задано как «ближе 48 часов», заказ за 10 часов до дедлайна попадал
 * сразу в оба и получал два письма в один проход.
 *
 * Заказ, созданный позже 48-часовой отметки, дальнего напоминания
 * не получает вовсе — и это правильно: оно опоздало.
 */
const WINDOWS = [
  { key: 'remind48', fromHours: 12, toHours: 48 },
  { key: 'remind12', fromHours: 0, toHours: 12 },
] as const

interface Candidate {
  id: string
  tenant_id: string
  public_code: string
  confirm_deadline: Date
  rental_end: Date
  timezone: string | null
}

/**
 * Дедлайн человеку — в поясе ФИЛИАЛА, куда он приедет.
 *
 * ⚠️ Подставляется в письмо как есть («Подтвердите до {{deadline}}»),
 * поэтому ISO-строка здесь недопустима: человек читает
 * «2026-09-05T21:54:40.166Z» как поломку, а не как срок.
 *
 * ⚠️ Пояс именно филиала, а не сервера: «до 21:00» должно значить
 * 21:00 там, где стоит прокат.
 */
function humanDeadline(at: Date, timezone: string | null): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: timezone ?? 'UTC',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }).format(at)
}

/**
 * Ставит в очередь напоминания по заказам, подошедшим к дедлайну.
 *
 * @param c     клиент в транзакции вызывающего: воркер открывает свою,
 *              тест — откатываемую
 * @param opts  tenantId сужает проход до одного тенанта (воркер идёт
 *              под ролью с BYPASSRLS и иначе увидел бы всех сразу);
 *              limit — сколько заказов брать за проход
 * @returns сколько напоминаний поставлено в очередь
 */
export async function remindUnconfirmed(
  c: PoolClient,
  opts: { tenantId?: string, limit?: number } = {},
): Promise<number> {
  const { tenantId, limit = 100 } = opts
  let queued = 0

  for (const w of WINDOWS) {
    const { rows } = await c.query<Candidate>(
      // ⚠️ Дедлайн ещё НЕ прошёл: истёкшими занимается expireUnconfirmed,
      // а «подтвердите» вдогонку снятой броне только путает.
      //
      // ⚠️ Нижняя граница у ближнего окна — не now(), иначе заказ,
      // проскочивший 12-часовую отметку между проходами, напоминания
      // не получит вовсе. Берём весь остаток до дедлайна, а от повторов
      // защищает ключ идемпотентности.
      `SELECT o.id, o.tenant_id, o.public_code, o.confirm_deadline,
              upper(o.period) AS rental_end,
              b.timezone
         FROM rental_order o
         JOIN branch b ON b.id = o.branch_pickup_id
        WHERE o.status = 'awaiting_confirm'
          AND o.confirm_deadline IS NOT NULL
          AND o.confirm_deadline > now()
          AND o.confirm_deadline >  now() + ($1 || ' hours')::interval
          AND o.confirm_deadline <= now() + ($2 || ' hours')::interval
          AND ($3::uuid IS NULL OR o.tenant_id = $3)
        ORDER BY o.confirm_deadline
        LIMIT $4`,
      [String(w.fromHours), String(w.toHours), tenantId ?? null, limit],
    )

    for (const row of rows) {
      // ⚠️ Токен подтверждения выписывается ЗАНОВО: в базе лежит только
      // хеш, восстановить выданный при оформлении нельзя. Несколько
      // живых токенов на одну цель — штатный случай, поиск идёт по хешу.
      const tokens = await issueOrderTokens(c, {
        tenantId: row.tenant_id,
        orderId: row.id,
        rentalEnd: new Date(row.rental_end),
      })

      await enqueue(c, {
        tenantId: row.tenant_id,
        kind: 'order.confirm_reminder',
        payload: {
          orderId: row.id,
          code: row.public_code,
          deadline: humanDeadline(row.confirm_deadline, row.timezone),
          // ⚠️ Кладём ТОКЕН, а не готовую ссылку: базовый адрес знает
          // слой доставки (он же собирает ссылки в order.confirm_link),
          // и домен не должен зависеть от того, как развёрнут стенд.
          confirmToken: tokens.confirm,
        },
        idempotencyKey: `${w.key}:${row.id}`,
      })
      queued++
    }
  }

  return queued
}
