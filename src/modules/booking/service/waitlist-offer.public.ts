/**
 * Забрать предложенную позицию по ссылке из уведомления (17.14).
 *
 * ⚠️ Приглашение уходит нескольким сразу, поэтому отказ здесь —
 * нормальный, ожидаемый исход, а не ошибка. И он обязан быть внятным:
 * человек пришёл по ссылке и должен понять, что произошло. Молчание
 * или общее «что-то пошло не так» здесь хуже прямого «позицию успели
 * забрать, вы остаётесь в очереди».
 *
 * ⚠️ Победителя определяет уникальный индекс в БД, а не этот
 * обработчик: два одновременных запроса иначе оба увидят «свободно»
 * (железное правило №2). См. claimOffer.
 *
 * ⚠️ Успех НЕ создаёт заказ и НЕ удерживает инвентарь: он снимает
 * с записи право на бронирование, дальше клиент проходит обычную
 * форму. Иначе лист ожидания стал бы способом получить бронь в обход
 * оплаты и подтверждения.
 */
import type { Deps } from '~/kernel/deps'
import { apiError } from '~/kernel/errors'
import { claimOffer } from '~/domain/availability/waitlist'
import { localized, type I18nField } from '~/common/utils/i18n-field'

/** Что сказать человеку по каждому исходу. Общего текста здесь нет. */
const REFUSAL: Record<string, string> = {
  taken: 'Позицию успел забрать другой — вы остаётесь в очереди на следующее освобождение.',
  expired: 'Время на ответ вышло, и предложение ушло дальше по очереди. Вы остаётесь в списке ожидания.',
  unknown: 'Ссылка недействительна.',
}

export interface PostWaitlistTokenInput {
  params: Record<string, string>
}

export async function postWaitlistToken(
  req: PostWaitlistTokenInput,
  deps: Deps,
) {
  const token = req.params.token ?? ''

  // ⚠️ Токен не кодирует тенанта (в отличие от токенов заказа): поиск
  // идёт мимо RLS по хешу, дальше работаем уже в тенантном контексте.
  const outcome = await deps.db.txAnonymous((c) => claimOffer(c, token))

  if (!outcome.ok) {
    // 409, а не 404: запрос понят, ссылка настоящая — изменилось
    // состояние. Для «unknown» это тоже верно: подтверждать
    // перебирающему, что токен не существует, незачем.
    throw apiError('WAITLIST_OFFER_LOST', REFUSAL[outcome.reason]!, {
      reason: outcome.reason,
    })
  }

  // Что именно освободилось — чтобы клиент сразу открыл форму
  // с нужным вариантом, а не искал его заново.
  const detail = await deps.db.txAnonymous(async (c) => {
    const { rows } = await c.query<{
      tenant_id: string
      tenant_slug: string
      branch_id: string
      variant_name: I18nField
      starts_at: Date
      ends_at: Date
    }>(
      `SELECT w.tenant_id, t.slug AS tenant_slug, w.branch_id,
              v.name AS variant_name,
              lower(w.period) AS starts_at, upper(w.period) AS ends_at
       FROM waitlist w
       JOIN tenant t ON t.id = w.tenant_id
       JOIN inventory_variant v ON v.id = w.variant_id
       WHERE w.id = $1`,
      [outcome.entry.id],
    )
    return rows[0]
  })

  if (!detail) throw apiError('NOT_FOUND', 'Запись не найдена')

  // Событие — в тенантном контексте: журнал живёт под RLS.
  await deps.db.tx(detail.tenant_id, (c) =>
    c.query(
      `INSERT INTO event (tenant_id, aggregate_type, aggregate_id, kind, payload, actor_type)
       VALUES ($1, 'waitlist', $2, 'waitlist.claimed', $3, 'customer')`,
      [detail.tenant_id, outcome.entry.id,
       JSON.stringify({ variantId: outcome.entry.variantId })],
    ),
  )

  return {
    ok: true,
    tenant: detail.tenant_slug,
    branchId: detail.branch_id,
    variantId: outcome.entry.variantId,
    variantName: localized(detail.variant_name, 'ru', 'Позиция'),
    from: detail.starts_at,
    to: detail.ends_at,
  }
}
