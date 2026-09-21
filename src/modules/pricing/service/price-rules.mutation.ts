/**
 * Прайс: создать правило или архивировать.
 *
 * ⚠️ Архив, не удаление: на правило ссылаются снимки старых заказов
 * через разбивку, и история цен нужна для перерасчётов.
 *
 * ⚠️ Пересечение БАЗОВЫХ ставок отклоняет EXCLUDE в БД (миграция 0009),
 * а не проверка здесь: проверка в коде гонку не закрывает. Модификаторы
 * пересекаться могут — конфликт разрешает движок по priority/stackable.
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import * as v from 'valibot'
import { apiError, mapDbError } from '~/kernel/errors'
import { audit } from '~/domain/core/order-lifecycle'
import {
  activeRule, archiveRule, closeRuleAt, insertRule,
} from '~/modules/pricing/database/pricing.repository'

const Body = v.variant('action', [
  v.object({
    action: v.literal('create'),
    variantId: v.pipe(v.string(), v.uuid()),
    ruleKind: v.picklist(['base', 'modifier']),
    amount: v.optional(v.pipe(v.string(), v.regex(/^-?\d+(\.\d{1,2})?$/))),
    dayRates: v.optional(v.array(v.pipe(v.number(), v.minValue(0)))),
    percent: v.optional(v.pipe(v.number(), v.integer(), v.minValue(-100), v.maxValue(500))),
    priority: v.optional(v.pipe(v.number(), v.integer())),
    stackable: v.optional(v.boolean()),
    validFrom: v.pipe(v.string(), v.isoTimestamp()),
    /** Пусто — бессрочно. ⚠️ В БД это бесконечная граница, а не NULL. */
    validTo: v.optional(v.pipe(v.string(), v.isoTimestamp())),
    label: v.optional(v.pipe(v.string(), v.maxLength(120))),
  }),
  v.object({ action: v.literal('archive'), ruleId: v.pipe(v.string(), v.uuid()) }),
  /**
   * Смена цены: закрыть действующее правило сегодняшним днём и завести
   * новое с той же даты.
   *
   * ⚠️ Отдельное действие, а не пара create+archive с клиента. Две
   * причины, обе проверены на живой базе:
   *
   * 1. Пара НИКОГДА не проходит для базовой ставки. Пока старое правило
   *    активно, его период (обычно до бесконечности) пересекается
   *    с новым, и EXCLUDE отклоняет вставку с 23P01. Порядок наоборот
   *    (сначала архив) оставил бы позицию без цены между запросами.
   * 2. Даже если бы проходила — это две транзакции, и отказ второй
   *    оставляет прайс в состоянии, которого не должно быть.
   */
  v.object({
    action: v.literal('replace'),
    ruleId: v.pipe(v.string(), v.uuid()),
    amount: v.optional(v.pipe(v.string(), v.regex(/^-?\d+(\.\d{1,2})?$/))),
    percent: v.optional(v.pipe(v.number(), v.integer(), v.minValue(-100), v.maxValue(500))),
    /** Дата окончания «YYYY-MM-DD». Пусто — бессрочно. */
    validTo: v.optional(v.union([v.pipe(v.string(), v.isoDate()), v.literal('')])),
    /**
     * Дата начала «YYYY-MM-DD».
     *
     * ⚠️ Принимается только для правила, которое ЕЩЁ НЕ ВСТУПИЛО в силу.
     * У действующего начало в прошлом, и сдвиг назад переписал бы
     * историю: заказы, уже посчитанные по нему, оказались бы посчитаны
     * по цене, которой тогда не было.
     */
    validFrom: v.optional(v.pipe(v.string(), v.isoDate())),
    /** Нелинейный прайс: цена за 1-й, 2-й, 3-й день… Пустой — обычная ставка. */
    dayRates: v.optional(v.array(v.pipe(v.number(), v.minValue(0)))),
  }),
])

export interface PostPriceRulesRequest {
  body: unknown
}

export async function postPriceRules(
  session: Session,
  req: PostPriceRulesRequest,
  deps: Deps,
) {
  const parsed = v.safeParse(Body, req.body)
  if (!parsed.success) throw apiError('VALIDATION_FAILED', 'Проверьте правило цены')
  const input = parsed.output

  try {
    return await deps.db.tx(session.tenantId, async (c) => {
      if (input.action === 'archive') {
        await archiveRule(c, input.ruleId, session.tenantId)
        await audit(c, { tenantId: session.tenantId, staffId: session.activeStaffId,
          action: 'price.archived', targetType: 'price_rule', targetId: input.ruleId })
        return { archived: true }
      }

      if (input.action === 'replace') {
        // Обе операции в ОДНОЙ транзакции withTenant: между ними
        // прайс не должен быть ни пустым, ни двойным.
        const old = await activeRule(c, input.ruleId, session.tenantId)
        if (!old) throw apiError('NOT_FOUND', 'Правило не найдено или уже архивировано')

        // ⚠️ Новая цена действует с БОЛЬШЕГО из «сейчас» и начала старого
        // правила: у правила, заведённого будущей датой, диапазон
        // [сейчас, …) оказался бы вывернутым, и tstzrange бросил бы
        // ошибку вместо понятного отказа.
        const now = new Date()
        const wasFuture = new Date(old.lower_at) > now
        // Начало двигаем только у будущего правила — см. схему выше.
        const startsAt = input.validFrom && wasFuture
          ? new Date(`${input.validFrom}T00:00:00Z`)
          : (wasFuture ? new Date(old.lower_at) : now)
        const from = startsAt.toISOString()

        // ⚠️ Правило, ещё НЕ ВСТУПИВШЕЕ в силу, архивируется ЦЕЛИКОМ,
        // а не закрывается моментом `from`.
        //
        // Для будущего правила `from` равен его собственному началу
        // (сдвигать начало в прошлое нельзя — это переписало бы
        // историю), поэтому `tstzrange(lower, from)` выходит ПУСТЫМ.
        // CHECK `price_rule_valid_not_null` такой интервал отклоняет
        // с 23514, а `mapDbError` переводит этот код как «не хватает
        // свободных единиц» — сообщение, не имеющее к прайсу никакого
        // отношения. На практике это означало, что цену, заведённую
        // будущей датой, нельзя изменить вообще: ни суммой, ни датой.
        //
        // Архив здесь корректен и по смыслу: правило ещё ни дня не
        // действовало, закрывать в нём нечего — по нему не посчитан ни
        // один заказ, и истории, которую надо сохранить, у него нет.
        if (wasFuture) {
          await archiveRule(c, input.ruleId, session.tenantId)
        } else {
          // Действующее правило закрывается тем же моментом, с которого
          // начинается новое: интервалы полуоткрытые, поэтому стык
          // получается без зазора и без нахлёста.
          await closeRuleAt(c, input.ruleId, session.tenantId, from)
        }

        // ⚠️ Верхняя граница — начало СЛЕДУЮЩЕГО дня после указанной
        // даты: интервал полуоткрытый, и «действует по 31 декабря»
        // должно включать сам 31-е, а не заканчиваться его полуночью.
        //
        // ⚠️ День прибавляется ЗДЕСЬ, а не в SQL (`+ interval '1 day'`),
        // как было раньше: это правило продукта, и в запросе оно
        // невидимо тому, кто читает обработчик. Дата приходит как
        // «YYYY-MM-DD», то есть полночь UTC, — прибавление суток к ней
        // однозначно и переходом на летнее время не искажается.
        const until = input.validTo
          ? new Date(Date.parse(`${input.validTo}T00:00:00Z`) + 86_400_000).toISOString()
          : null

        const madeId = await insertRule(c, {
          tenantId: session.tenantId,
          variantId: old.variant_id,
          ruleKind: old.rule_kind,
          from,
          untilExclusive: until,
          amount: input.amount ?? null,
          dayRates: input.dayRates?.length
            ? JSON.stringify(input.dayRates)
            : (input.dayRates ? null : (old.day_rates as string | null) ?? null),
          percent: input.percent ?? null,
          priority: old.priority,
          stackable: old.stackable,
        })
        await audit(c, { tenantId: session.tenantId, staffId: session.activeStaffId,
          action: 'price.replaced', targetType: 'price_rule', targetId: madeId,
          after: { from: input.ruleId, amount: input.amount, percent: input.percent } })
        return { id: madeId }
      }

      if (input.ruleKind === 'base' && !input.amount && !input.dayRates?.length) {
        throw apiError('VALIDATION_FAILED', 'У базовой ставки нужна сумма или сетка по дням')
      }
      if (input.ruleKind === 'modifier' && !input.amount && input.percent == null) {
        throw apiError('VALIDATION_FAILED', 'У модификатора нужна сумма или процент')
      }

      const createdId = await insertRule(c, {
        tenantId: session.tenantId,
        variantId: input.variantId,
        ruleKind: input.ruleKind,
        from: input.validFrom,
        // ⚠️ В отличие от `replace`, здесь validTo — полный
        // ISO-timestamp (v.isoTimestamp в схеме), а не календарная дата:
        // момент задан точно, и сутки к нему НЕ прибавляются.
        untilExclusive: input.validTo ?? null,
        amount: input.amount ?? null,
        dayRates: input.dayRates ? JSON.stringify(input.dayRates) : null,
        percent: input.percent ?? null,
        priority: input.priority ?? 100,
        stackable: input.stackable ?? false,
      })
      await audit(c, { tenantId: session.tenantId, staffId: session.activeStaffId,
        action: 'price.created', targetType: 'price_rule', targetId: createdId, after: input })
      return { id: createdId }
    })
  } catch (err) {
    // EXCLUDE на базовые ставки — 23P01. Для прайса это не «вещь занята».
    if ((err as { code?: string }).code === '23P01') {
      throw apiError('VALIDATION_FAILED',
        'На эти даты у варианта уже есть базовая ставка: две одновременно означали бы неоднозначную цену')
    }
    throw mapDbError(err)
  }
}
