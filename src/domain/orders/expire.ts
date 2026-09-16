/**
 * Автоматическое снятие броней — то, ради чего существует дедлайн.
 *
 * Без этого процесса дедлайн подтверждения только записан в базу, но
 * ничего не делает, и защита от блокировки арсенала не работает
 * (../rental-docs/docs/04-тз/10-бэкенд/12-наличие-и-жизненный-цикл.md).
 *
 * Три разных механизма, которые легко спутать:
 *
 *   hold_expires_at    20 минут, окно оформления. Защищает только
 *                      корзину, ничего не делает с бронью на субботу;
 *   confirm_deadline    сутки до начала. Главный механизм: не
 *                      подтвердил — инвентарь вернулся в пул;
 *   overdue             не вернул в срок. Не снимает бронь, а меняет
 *                      статус: вещь физически отсутствует.
 *
 * ⚠️ Брони «на сегодня» дедлайна не имеют вовсе (confirm_deadline IS
 * NULL) и этим процессом не трогаются — их снимает только оператор.
 */
import { getWorkerPool } from '~/kernel/db'
import { transition } from '../core/order-lifecycle'
import { enqueue } from '../core/outbox'

export interface ExpireResult {
  expired: number
  overdue: number
  codes: string[]
}

/**
 * Снимает неподтверждённые брони с истёкшим дедлайном.
 *
 * ⚠️ Каждый заказ в СВОЕЙ транзакции: одна проблемная бронь не должна
 * блокировать снятие остальных. Пачка в одной транзакции означала бы,
 * что первая же ошибка откатывает всю работу.
 */
export async function expireUnconfirmed(limit = 50): Promise<ExpireResult> {
  const pool = getWorkerPool()
  const codes: string[] = []

  // Кандидаты выбираются одним запросом, дальше каждый обрабатывается
  // отдельно: список короткий, а изоляция важнее.
  const { rows } = await pool.query<{ id: string, tenant_id: string, public_code: string }>(
    `SELECT id, tenant_id, public_code
     FROM rental_order
     WHERE status = 'awaiting_confirm'
       AND confirm_deadline IS NOT NULL
       AND confirm_deadline <= now()
     ORDER BY confirm_deadline
     LIMIT $1`,
    [limit],
  )

  for (const row of rows) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      // RLS обходится ролью воркера, но tenant_id всё равно выставляется:
      // вложенные запросы (release пула) полагаются на него.
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [row.tenant_id])

      const { changed } = await transition(client, {
        orderId: row.id,
        to: 'expired',
        // system, а не staff: это автоматика, и в audit_log её писать
        // не нужно — там только ручные вмешательства.
        actor: { type: 'system' },
        payload: { reason: 'не подтверждено к дедлайну' },
      })

      if (changed) {
        await enqueue(client, {
          tenantId: row.tenant_id,
          kind: 'order.expired',
          payload: { orderId: row.id, code: row.public_code },
          idempotencyKey: `expired:${row.id}`,
        })
        codes.push(row.public_code)
      }

      await client.query('COMMIT')
    } catch {
      await client.query('ROLLBACK')
      // Ошибка на одном заказе не останавливает остальные: следующий
      // проход попробует снова, дедлайн уже в прошлом.
    } finally {
      client.release()
    }
  }

  return { expired: codes.length, overdue: 0, codes }
}

/**
 * Помечает невозвращённые вовремя заказы как overdue.
 *
 * ⚠️ Инвентарь НЕ освобождается: вещь физически у клиента. Это ровно
 * та комбинация, которую ТЗ называет самой опасной — забронировано и
 * физически отсутствует. Поэтому overdue остаётся в списке статусов,
 * удерживающих пул.
 */
export async function markOverdue(limit = 50): Promise<number> {
  const pool = getWorkerPool()

  const { rows } = await pool.query<{ id: string, tenant_id: string }>(
    `SELECT id, tenant_id
     FROM rental_order
     WHERE status IN ('issued', 'partially_returned')
       AND upper(period) <= now()
     ORDER BY upper(period)
     LIMIT $1`,
    [limit],
  )

  let n = 0
  for (const row of rows) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [row.tenant_id])

      const { changed } = await transition(client, {
        orderId: row.id,
        to: 'overdue',
        actor: { type: 'system' },
        payload: { reason: 'срок аренды истёк, возврат не отмечен' },
      })
      if (changed) n++

      await client.query('COMMIT')
    } catch {
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  }

  return n
}

/**
 * Освобождает корзины с истёкшим TTL.
 *
 * ⚠️ Это НЕ то же, что дедлайн подтверждения. hold_expires_at защищает
 * окно оформления (20 минут), и к брони на следующую субботу отношения
 * не имеет: TTL к тому времени давно истёк.
 *
 * Трогаются только черновики: у оформленного заказа hold уже не важен.
 */
export async function expireHolds(limit = 100): Promise<number> {
  const pool = getWorkerPool()

  const { rows } = await pool.query<{ id: string, tenant_id: string }>(
    `SELECT id, tenant_id
     FROM rental_order
     WHERE status = 'draft'
       AND hold_expires_at IS NOT NULL
       AND hold_expires_at <= now()
     LIMIT $1`,
    [limit],
  )

  let n = 0
  for (const row of rows) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [row.tenant_id])

      const { changed } = await transition(client, {
        orderId: row.id,
        to: 'cancelled',
        actor: { type: 'system' },
        payload: { reason: 'истёк срок удержания корзины' },
      })
      if (changed) n++

      await client.query('COMMIT')
    } catch {
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  }

  return n
}
