/**
 * Данные для демонстрационного обхода (экран `/tour` на фронте).
 *
 * ⚠️ Выдаёт ЖИВЫЕ токены заказа — то есть ссылки, по которым посторонний
 * подтвердит или отменит чужую бронь. Поэтому закрыт по умолчанию и
 * открывается ТОЛЬКО `ALLOW_DEV_PAGES=1` (вне продакшена — всегда).
 * На хосте заказчика переменной нет, и маршрут отвечает 404.
 *
 * ⚠️ Токены ВЫПИСЫВАЮТСЯ ЗАНОВО, а не читаются из базы: в `order_token`
 * хранится только хеш, сам токен не восстановим — и это правильно,
 * иначе утечка дампа означала бы доступ ко всем заказам.
 *
 * ⚠️ Зашить пример в код было нельзя: он протух бы на первом же
 * `make reset`, и демонстрация начиналась бы с объяснения, почему
 * ссылка не открывается.
 *
 * ⚠️ Маршрут ПОТЕРЯЛСЯ при выносе бэкенда (`aa62c27`): 52 роута
 * переехали, а этот удалился вместе с `server/`. Страница `/tour`
 * при этом продолжала открываться и выглядела рабочей — просто
 * показывала 9 пунктов вместо 24: пропадало всё, что зависит от
 * данных стенда (заказ по токену, карточка стойки, подтверждение
 * и отмена).
 */
import type { Deps } from '~/kernel/deps'
import { apiError } from '~/kernel/errors'
import { getWorkerPool } from '~/kernel/db'
import { issueOrderTokens } from '~/domain/orders/order-token'
import { loadConfig } from '~/kernel/config'

export async function getTour(deps: Deps) {
  // ⚠️ Fail closed: переменной нет — значит закрыто.
  if (!loadConfig().allowDevPages) throw apiError('NOT_FOUND', 'Недоступно')

  /**
   * ⚠️ Через ВОРКЕРНЫЙ пул, а не основной. Обзор ищет «любой заказ,
   * на котором есть что показать» — то есть идёт ПОПЕРЁК тенантов,
   * а приложение ходит под ролью с RLS: без установленного тенанта
   * все строки скрыты, и выборка молча вернула бы пусто. Так и было
   * на стенде: эндпоинт отвечал 200, а пункты про заказ не появлялись.
   *
   * ⚠️ Это НЕ послабление RLS: роль воркера берётся ровно здесь,
   * в служебном маршруте за ALLOW_DEV_PAGES, и только для чтения.
   */
  const c = await getWorkerPool().connect()
  let found
  try {
    const { rows: tenants } = await c.query<{ slug: string, name: string }>(
      `SELECT slug, name FROM tenant WHERE archived_at IS NULL
        ORDER BY created_at LIMIT 5`,
    )

    // Заказ, на котором есть что показать: ждёт подтверждения — значит
    // кнопки «подтвердить» и «отменить» на экране клиента живые.
    const { rows: pending } = await c.query<{
      id: string, tenant_id: string, code: string, ends_at: Date
    }>(
      `SELECT id, tenant_id, public_code AS code, upper(period) AS ends_at
         FROM rental_order
        WHERE status = 'awaiting_confirm'
        ORDER BY created_at DESC LIMIT 1`,
    )

    // Подтверждённый заказ — чтобы на стойке было что выдавать.
    const { rows: ready } = await c.query<{ id: string, code: string }>(
      `SELECT id, public_code AS code FROM rental_order
        WHERE status IN ('confirmed', 'issued')
        ORDER BY created_at DESC LIMIT 1`,
    )

    found = { tenants, pending: pending[0] ?? null, ready: ready[0] ?? null }
  } finally {
    c.release()
  }

  let links: { view: string, confirm: string, cancel: string } | null = null
  let orderCode: string | null = null

  if (found.pending) {
    const p = found.pending
    const tokens = await deps.db.tx(p.tenant_id, (tc) => issueOrderTokens(tc, {
      tenantId: p.tenant_id,
      orderId: p.id,
      rentalEnd: p.ends_at,
    }))
    orderCode = p.code
    links = {
      view: `/o/${tokens.view}`,
      confirm: `/o/${tokens.confirm}/confirm`,
      cancel: `/o/${tokens.cancel}/cancel`,
    }
  }

  return { tenants: found.tenants, orderCode, links, counterOrder: found.ready }
}
