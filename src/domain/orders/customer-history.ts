/**
 * Узнавание повторного клиента.
 *
 * ⚠️ НЕ скидки и НЕ приоритет — это запрещено публичным договором
 * (../rental-docs/docs/04-тз/00-общее/04-правовое.md). Только скорость и точность: выдача
 * из 10 секунд превращается в 5, потому что не нужно заново измерять
 * и подбирать. Меняется скорость обслуживания, а не цена и не очередь,
 * поэтому юридически это чисто.
 *
 * ⚠️ Три границы по персональным данным, и они не рекомендации:
 *
 *   параметры тела подставляются ТОЛЬКО при согласии «запомнить мои
 *   параметры» — без него их просто нет в ответе;
 *   история видна в пределах ФИЛИАЛА сотрудника, а не всей сети;
 *   показывается только в контексте текущего заказа, а не как
 *   свободный поиск по базе клиентов — поэтому вход здесь по
 *   orderId, а не по телефону.
 *
 * Последнее важнее, чем кажется: функция «найти клиента по телефону и
 * посмотреть его историю» превратила бы стойку в инструмент выгрузки
 * ПД, и 152-ФЗ этого не разрешает (доступ без необходимости).
 */
import type { PoolClient } from 'pg'

export interface CustomerHistory {
  /** Какая это аренда по счёту, включая текущую. */
  rentalCount: number
  lastRentalAt: Date | null
  /** Что брал в прошлый раз — подсказка подбора, не обязательство. */
  previousItems: { variantName: string, categoryCode: string }[]
  /** Последнее фактическое значение DIN и кто его выставлял. */
  lastDin: { value: string, verifiedBy: string | null } | null
  /**
   * Сохранённые параметры тела.
   *
   * null, если согласия «запомнить мои параметры» нет — и это не
   * ошибка данных, а соблюдение границы.
   */
  bodyParams: Record<string, number> | null
}

/**
 * История клиента по текущему заказу.
 *
 * @param branchIds филиалы, доступные сотруднику. Пустой массив
 *                  означает «все» — так у владельца и администратора.
 */
export async function historyForOrder(
  c: PoolClient,
  opts: { tenantId: string, orderId: string, branchIds: string[] },
): Promise<CustomerHistory | null> {
  const { rows: cur } = await c.query<{
    customer_id: string | null
    branch_id: string
  }>(
    `SELECT customer_id, branch_pickup_id AS branch_id
     FROM rental_order WHERE id = $1 AND tenant_id = $2`,
    [opts.orderId, opts.tenantId],
  )
  const order = cur[0]
  if (!order?.customer_id) return null

  // ⚠️ Граница филиала: если сотруднику доступны конкретные филиалы,
  // история собирается только по ним. Иначе сотрудник одной точки
  // увидит, что клиент брал в другом городе.
  const scoped = opts.branchIds.length > 0

  const { rows: stats } = await c.query<{
    rental_count: string
    last_rental_at: Date | null
  }>(
    `SELECT count(*)::text AS rental_count, MAX(lower(period)) AS last_rental_at
     FROM rental_order
     WHERE tenant_id = $1 AND customer_id = $2
       AND status IN ('issued', 'partially_returned', 'returned', 'overdue')
       AND (NOT $3 OR branch_pickup_id = ANY($4::uuid[]))`,
    [opts.tenantId, order.customer_id, scoped, opts.branchIds],
  )

  const { rows: items } = await c.query<{
    variant_name: { ru?: string }
    category_code: string
  }>(
    `SELECT v.name AS variant_name, cat.code AS category_code
     FROM order_line l
     JOIN rental_order o ON o.id = l.order_id
     JOIN inventory_variant v ON v.id = l.variant_id
     JOIN category cat ON cat.id = v.category_id
     WHERE o.tenant_id = $1 AND o.customer_id = $2 AND o.id <> $3
       AND l.status IN ('picked_up', 'returned')
       AND (NOT $4 OR o.branch_pickup_id = ANY($5::uuid[]))
     ORDER BY lower(o.period) DESC
     LIMIT 6`,
    [opts.tenantId, order.customer_id, opts.orderId, scoped, opts.branchIds],
  )

  // Прошлый DIN — отправная точка для техника, а не готовое значение:
  // фактическое он всё равно выставляет и подписывает сам.
  const { rows: din } = await c.query<{
    din_actual: string
    verified_by_name: string | null
  }>(
    `SELECT l.din_actual, st.name AS verified_by_name
     FROM order_line l
     JOIN rental_order o ON o.id = l.order_id
     LEFT JOIN staff st ON st.id = l.verified_by
     WHERE o.tenant_id = $1 AND o.customer_id = $2 AND o.id <> $3
       AND l.din_actual IS NOT NULL
       AND (NOT $4 OR o.branch_pickup_id = ANY($5::uuid[]))
     ORDER BY l.verified_at DESC NULLS LAST
     LIMIT 1`,
    [opts.tenantId, order.customer_id, opts.orderId, scoped, opts.branchIds],
  )

  // ⚠️ Параметры тела — только при действующем согласии.
  const { rows: consent } = await c.query<{ body_params: Record<string, number> | null }>(
    `SELECT cu.body_params
     FROM customer cu
     WHERE cu.id = $1
       AND EXISTS (
         SELECT 1 FROM consent co
         WHERE co.customer_id = cu.id
           AND co.kind = 'save_params'
           AND co.revoked_at IS NULL
       )`,
    [order.customer_id],
  )

  return {
    rentalCount: Number(stats[0]?.rental_count ?? 0),
    lastRentalAt: stats[0]?.last_rental_at ?? null,
    previousItems: items.map((i) => ({
      variantName: i.variant_name?.ru ?? 'Позиция',
      categoryCode: i.category_code,
    })),
    lastDin: din[0]
      ? { value: din[0].din_actual, verifiedBy: din[0].verified_by_name }
      : null,
    bodyParams: consent[0]?.body_params ?? null,
  }
}
