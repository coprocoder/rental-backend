/**
 * Мутации модуля `counter`.
 *
 * ⚠️ Право и тариф — ДВЕ РАЗНЫЕ проверки, и для мутаций цена ошибки
 * выше, чем для чтения: забытая проверка тарифа раздаёт платную
 * функцию, забытое право — доступ к чужим действиям.
 */
import type { App } from '~/transport/types'
import type { Deps } from '~/kernel/deps'
import * as v from 'valibot'
import { documentRoute } from '~/transport/openapi/registry'
import { SESSION_COOKIE, requirePermission, requireSession } from '~/kernel/session'
import { postDin, DinBody } from '../service/din.mutation'
import { postIncident, IncidentBody } from '../service/incident.mutation'
import { postIssue, IssueBody } from '../service/issue.mutation'
import { postReturn, ReturnBody } from '../service/return.mutation'
import { postShift, ShiftBody } from '../service/shift.mutation'
import { postStocktake, StocktakeBody } from '../service/stocktake.mutation'
import { postUpsell, UpsellBody } from '../service/upsell.mutation'
import { postWalkIn, WalkInBody } from '../service/walk-in.mutation'

/** Сводка смены — основа передачи между сотрудниками. */
const ShiftSummarySchema = v.object({
  id: v.pipe(v.string(), v.uuid()),
  openedAt: v.string(),
  isImplicit: v.boolean(),
  issued: v.number(),
  returned: v.number(),
  /** Незакрытые выдачи — то, что вечерний сотрудник наследует. */
  outstanding: v.number(),
  overdue: v.number(),
  cashOpen: v.nullable(v.string()),
})

documentRoute({ method: 'post', path: '/v1/counter/din', scope: 'staff',
  body: DinBody,
  /**
   * ⚠️ Результат — РЕКОМЕНДАЦИЯ, наряд для техника (железное правило 7).
   * Диапазон, а не точка: переход от момента ISO к значению шкалы
   * задаётся таблицей конкретного крепления, точную цифру выставляет
   * человек. Сверено вызовом: код K, диапазон [5.5, 8].
   */
  response: v.object({
    /** Код навыка A–P по ISO — это и есть результат расчёта. */
    code: v.string(),
    range: v.nullable(v.tuple([v.number(), v.number()])),
    chartVersion: v.string(),
    /** Почему получился такой код — техник должен видеть основание. */
    why: v.array(v.string()),
    /** Чего не хватает для расчёта. */
    missing: v.array(v.string()),
    /** Куда двигаться внутри диапазона с учётом подошвы. */
    bslHint: v.nullable(v.string()),
  }),
  summary: 'Расчёт рекомендации DIN: наряд технику, а не готовое значение' })

documentRoute({ method: 'post', path: '/v1/counter/issue', scope: 'staff',
  body: IssueBody,
  response: v.object({
    /** Расхождения «ожидали / выдали по факту» — не блокируют выдачу. */
    mismatches: v.array(v.object({
      variantId: v.pipe(v.string(), v.uuid()),
      expected: v.number(),
      actual: v.number(),
    })),
    status: v.string(),
    shiftId: v.pipe(v.string(), v.uuid()),
  }),
  summary: 'Выдача снаряжения: позиции, фактический DIN и подпись техника' })

documentRoute({ method: 'post', path: '/v1/counter/return', scope: 'staff',
  body: ReturnBody,
  response: v.object({
    status: v.string(),
    allReturned: v.boolean(),
    shiftId: v.pipe(v.string(), v.uuid()),
    /**
     * ⚠️ Пересчёт при досрочном возврате — `null`, если пересчитывать
     * нечего. Считается по СНИМКУ правил заказа (железное правило 6).
     */
    recalc: v.nullable(v.object({
      total: v.string(),
      originalTotal: v.string(),
      /** Сколько вернуть клиенту. Ноль, если возвращать нечего. */
      refund: v.string(),
      lines: v.array(v.object({
        variantId: v.pipe(v.string(), v.uuid()),
        variantName: v.string(),
        qty: v.number(),
        actualDays: v.number(),
        originalDays: v.number(),
        unitPerDay: v.string(),
        lineTotal: v.string(),
      })),
      /** Сработало ли ограничение «не дороже первоначальной суммы». */
      cappedAtOriginal: v.boolean(),
    })),
  }),
  summary: 'Приём снаряжения с пересчётом при досрочном возврате' })

documentRoute({ method: 'post', path: '/v1/counter/shift', scope: 'staff',
  body: ShiftBody,
  response: v.union([
    v.object({ id: v.pipe(v.string(), v.uuid()), adopted: v.boolean(), summary: v.nullable(ShiftSummarySchema) }),
    v.object({ closed: v.literal(true), summary: v.nullable(ShiftSummarySchema) }),
  ]),
  summary: 'Открытие и закрытие смены со сводкой для передачи' })

documentRoute({ method: 'post', path: '/v1/counter/stocktake', scope: 'staff',
  body: StocktakeBody,
  response: v.object({
    sheet: v.array(v.object({
      variantId: v.pipe(v.string(), v.uuid()),
      variantName: v.string(),
      categoryCode: v.string(),
      /** Сколько должно быть по журналу движений. */
      expected: v.number(),
      /** В обслуживании: выдать нельзя, но вещь существует. */
      inService: v.number(),
    })),
    /** Забытое в ремонте — вторая половина сезонной ревизии. */
    stuck: v.array(v.object({
      variantId: v.pipe(v.string(), v.uuid()),
      variantName: v.string(),
      qty: v.number(),
      serviceKind: v.nullable(v.string()),
      since: v.string(),
      days: v.number(),
    })),
  }),
  summary: 'Ревизия склада: лист пересчёта и забытое в обслуживании' })

documentRoute({ method: 'post', path: '/v1/counter/upsell', scope: 'staff',
  body: UpsellBody,
  response: v.object({
    ok: v.literal(true),
    /** Новый итог заказа и сумма добавленной строки. */
    total: v.string(),
    amount: v.string(),
  }),
  summary: 'Допродажа на стойке: добавить позицию в оформленный заказ' })

documentRoute({ method: 'post', path: '/v1/counter/walk-in', scope: 'staff',
  body: WalkInBody,
  response: v.object({
    orderId: v.pipe(v.string(), v.uuid()),
    publicCode: v.string(),
    shiftId: v.pipe(v.string(), v.uuid()),
    total: v.string(),
    days: v.number(),
  }),
  summary: 'Выдача без брони: заказ оформляется на месте' })

documentRoute({ method: 'post', path: '/v1/counter/incident', scope: 'staff',
  body: IncidentBody,
  response: v.object({ ok: v.literal(true) }),
  summary: 'Происшествие на смене: поломка, утеря, просрочка' })

export function registerCounterMutations(app: App, deps: Deps): void {
  app.post('/v1/counter/din', async (httpReq) => {
    const s = await requirePermission(httpReq.cookies[SESSION_COOKIE], 'din.record')
    return postDin(s, { body: httpReq.body }, deps)
  })
  app.post('/v1/counter/incident', async (httpReq) => {
    const s = await requireSession(httpReq.cookies[SESSION_COOKIE])
    return postIncident(s, { body: httpReq.body }, deps)
  })
  app.post('/v1/counter/issue', async (httpReq) => {
    const s = await requireSession(httpReq.cookies[SESSION_COOKIE])
    return postIssue(s, { body: httpReq.body }, deps)
  })
  app.post('/v1/counter/return', async (httpReq) => {
    const s = await requireSession(httpReq.cookies[SESSION_COOKIE])
    return postReturn(s, { body: httpReq.body }, deps)
  })
  app.post('/v1/counter/shift', async (httpReq) => {
    const s = await requireSession(httpReq.cookies[SESSION_COOKIE])
    return postShift(s, { body: httpReq.body }, deps)
  })
  app.post('/v1/counter/stocktake', async (httpReq) => {
    const s = await requirePermission(httpReq.cookies[SESSION_COOKIE], 'inventory.manage')
    return postStocktake(s, { body: httpReq.body }, deps)
  })
  app.post('/v1/counter/upsell', async (httpReq) => {
    const s = await requireSession(httpReq.cookies[SESSION_COOKIE])
    return postUpsell(s, { body: httpReq.body }, deps)
  })
  app.post('/v1/counter/walk-in', async (httpReq) => {
    const s = await requireSession(httpReq.cookies[SESSION_COOKIE])
    return postWalkIn(s, { body: httpReq.body }, deps)
  })
}
