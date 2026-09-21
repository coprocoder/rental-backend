/**
 * Расчёт цены и подбор размера.
 * POST /api/v1/public/quote
 *
 * ⚠️ Отдельный вызов, а не поле в каталоге: цена зависит от интервала,
 * набора позиций и правил — она ВЫЧИСЛЯЕТСЯ, а не хранится.
 */
import type { Deps } from '~/kernel/deps'
import * as v from 'valibot'
import { apiError } from '~/kernel/errors'
import { quote } from '~/domain/pricing/pricing'
import { checkAvailability } from '~/domain/availability/availability'
import { nearbyWindows } from '~/domain/availability/nearby'
import { suggest, type BodyParams } from '~/domain/fitting/fitting'
import type { FitRow } from '~/domain/fitting/fit-rules'
import { checkBusinessHours } from '~/domain/availability/schedule'
import type { DayMode } from '~/common/contract/day-count'

// ⚠️ Схема на границе, а не типы роута: Nitro проверяет типы только
// ответов, но никогда тел запросов.
export const QuoteBody = v.object({
  tenant: v.pipe(v.string(), v.minLength(1)),
  branchId: v.pipe(v.string(), v.uuid()),
  from: v.pipe(v.string(), v.isoTimestamp()),
  to: v.pipe(v.string(), v.isoTimestamp()),
  body: v.optional(v.object({
    height: v.optional(v.pipe(v.number(), v.minValue(100), v.maxValue(220))),
    weight: v.optional(v.pipe(v.number(), v.minValue(20), v.maxValue(200))),
    shoeSizeEu: v.optional(v.pipe(v.number(), v.minValue(28), v.maxValue(52))),
    headCircumference: v.optional(v.pipe(v.number(), v.minValue(45), v.maxValue(70))),
  })),
  lines: v.array(v.object({
    variantId: v.pipe(v.string(), v.uuid()),
    qty: v.pipe(v.number(), v.integer(), v.minValue(1)),
  })),
  /**
   * Варианты, по которым нужно ТОЛЬКО наличие, без цены.
   *
   * ⚠️ Форма показывает соседние размеры той же категории и зачёркивает
   * занятые. Без этого списка она знала бы наличие лишь по выбранному
   * варианту, а остальные рисовала бы по устаревшему ответу: нажатый
   * размер на долю секунды показывался выбранным и тут же зачёркнутым.
   */
  probe: v.optional(v.array(v.pipe(v.string(), v.uuid()))),
})

export interface PostQuoteInput {
  body: unknown
}

export async function postQuote(
  req: PostQuoteInput,
  deps: Deps,
) {
  const parsed = v.safeParse(QuoteBody, req.body)
  if (!parsed.success) {
    throw apiError('VALIDATION_FAILED', 'Неверные данные', {
      issues: parsed.issues.map((i) => ({ path: i.path?.map((p) => p.key).join('.'), message: i.message })),
    })
  }
  const input = parsed.output

  const tenants = await deps.db.unscoped<{ id: string, day_mode: string }>(
    `SELECT id, day_mode FROM tenant WHERE slug = $1 AND archived_at IS NULL`,
    [input.tenant],
  )
  const tenant = tenants[0]
  if (!tenant) throw apiError('TENANT_NOT_FOUND', 'Прокат не найден')

  const branches = await deps.db.tx(tenant.id, async (c) => {
    const { rows } = await c.query<{ timezone: string }>(
      `SELECT timezone FROM branch WHERE id = $1 AND tenant_id = $2`,
      [input.branchId, tenant.id],
    )
    return rows
  })
  const timezone = branches[0]?.timezone
  if (!timezone) throw apiError('NOT_FOUND', 'Филиал не найден')

  const from = new Date(input.from)
  const to = new Date(input.to)

  return deps.db.tx(tenant.id, async (c) => {
    // Часы работы: проверяются ОБЕ границы аренды.
    // ⚠️ Не бросаем ошибку, а возвращаем результат: на этапе расчёта
    // клиент ещё подбирает даты, и падение вместо подсказки заставит
    // его угадывать. Отказ — задача создания заказа.
    const businessHours = await checkBusinessHours(c, {
      branchId: input.branchId, from, to, timezone,
    })

    // Наличие по позициям заказа и по вариантам, которые форма показывает
    // рядом. ⚠️ По дням, не наивным SUM.
    //
    // probe считается тем же запросом, а не отдельным: два обращения дали бы
    // два момента времени, и соседний размер мог бы «освободиться» между ними.
    const probes = (input.probe ?? [])
      .filter((id) => !input.lines.some((l) => l.variantId === id))
      .map((id) => ({ variantId: id, qty: 1, probeOnly: true }))

    const availability = await Promise.all(
      [...input.lines.map((l) => ({ ...l, probeOnly: false })), ...probes].map(async (l) => {
        const a = await checkAvailability(c, {
          tenantId: tenant.id,
          variantId: l.variantId,
          from, to, timezone, qty: l.qty,
        })

        // ⚠️ Соседние даты считаются ТОЛЬКО при отказе (17.14) и только
        // для позиций заказа: это перебор окон, и платить за него на каждом
        // расчёте цены — да ещё и по всем соседним размерам — незачем.
        // «Занято» без альтернативы — потерянный клиент, «занято, но свободно
        // в пятницу» оставляет ему выбор.
        const nearby = a.available || l.probeOnly
          ? []
          : await nearbyWindows(c, {
              variantId: l.variantId,
              from, to, timezone, qty: l.qty,
            })

        return { variantId: l.variantId, ...a, nearby }
      }),
    )

    const priced = await quote(c, {
      tenantId: tenant.id,
      lines: input.lines,
      from, to,
      dayMode: tenant.day_mode as DayMode,
      timezone,
    })

    // Подбор: предлагает с объяснением, клиент может изменить.
    let suggestions: ReturnType<typeof suggest> = []
    if (req.body) {
      // ⚠️ Читаем тем же `c`, что и всё остальное в сценарии: отдельная
      // транзакция дала бы второй снимок данных, между которыми склад
      // мог измениться.
      const { rows: cats } = await c.query<{ code: string, variants: { code: string, bucket: Record<string, unknown> }[] }>(
        `SELECT c.code,
                json_agg(json_build_object('code', v.code, 'bucket', v.size_bucket)
                         ORDER BY v.code) AS variants
         FROM category c
         JOIN inventory_variant v ON v.category_id = c.id AND v.archived_at IS NULL
         WHERE c.tenant_id = $1 AND c.code <> 'service'
         GROUP BY c.code`,
        [tenant.id],
      )
      // ⚠️ Таблицы подбора тенанта имеют приоритет над встроенными
      // формулами (13.10): у каждого проката своя политика, и менять
      // её он должен без нашего релиза. Пустая таблица — не «подбора
      // нет», а «работают умолчания».
      const { rows: fitRows } = await c.query<{ code: string, rule: unknown }>(
        `SELECT c.code, f.rule
         FROM fit_rule f
         JOIN category c ON c.id = f.category_id
         WHERE f.tenant_id = $1 AND f.is_active AND f.archived_at IS NULL`,
        [tenant.id],
      )
      const tables = new Map(fitRows.map((r) => [
        r.code,
        ((r.rule as { rows?: FitRow[] })?.rows ?? []),
      ]))

      suggestions = suggest(cats, req.body as BodyParams, tables)
    }

    return { ...priced, availability, suggestions, businessHours }
  })
}
