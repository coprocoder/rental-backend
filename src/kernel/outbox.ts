/**
 * Публикация эффекта в outbox — единственный способ, которым модуль
 * сообщает остальным, что что-то произошло.
 *
 * ⚠️ Таблица в Postgres, а не Redis. Redis НЕ участвует в транзакции
 * Postgres: при падении между COMMIT и записью в очередь заказ был бы
 * создан, а уведомление потеряно. Запись в ту же транзакцию, что и
 * изменение состояния, делает это невозможным.
 *
 * ⚠️ Гарантия «хотя бы один раз»: обработчик может получить одно и то же
 * событие дважды, поэтому подписчики ОБЯЗАНЫ быть идемпотентны.
 */
import type { PoolClient } from 'pg'

export interface Notifier {
  /**
   * Кладёт эффект в очередь. Вызывается ВНУТРИ транзакции состояния —
   * иначе теряется весь смысл паттерна.
   */
  publish(c: PoolClient, opts: {
    tenantId: string
    kind: string
    payload: Record<string, unknown>
    /**
     * ⚠️ ОБЯЗАТЕЛЕН: колонка NOT NULL и уникальна в пределах тенанта.
     * Без ключа повторная запись того же эффекта создала бы второе
     * письмо о том же заказе.
     */
    idempotencyKey: string
    correlationId?: string | undefined
  }): Promise<void>
}

export const outboxNotifier: Notifier = {
  async publish(c, opts) {
    await c.query(
      `INSERT INTO outbox (tenant_id, kind, payload, idempotency_key, correlation_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
      [
        opts.tenantId,
        opts.kind,
        JSON.stringify(opts.payload),
        opts.idempotencyKey,
        opts.correlationId ?? null,
      ],
    )
  },
}
