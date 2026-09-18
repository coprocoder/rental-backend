/**
 * Схема карточки заказа — ОДНА для админки и для стойки.
 *
 * ⚠️ Зачем общая. Оба роута — `/v1/admin/orders/:id` и
 * `/v1/counter/orders/:id` — отдают результат одной и той же доменной
 * функции `orderDetail` (см. её комментарий: расхождение между тем, что
 * видит стойка, и тем, что видит админка, — это спор между сотрудниками
 * о составе заказа). Две схемы на один объект разошлись сразу же:
 * админская описывала строки заказа по полям, а стойка — как
 * `record(string, unknown)`, и экран стойки получал `unknown` вместо
 * типа. 34 ошибки компиляции из 59 приходились ровно на это.
 *
 * ⚠️ Схема живёт в `transport/`, а не в модуле: `counter` не имеет права
 * импортировать внутренности `booking` (правило `module-private-internals`),
 * и попытка переиспользовать схему «по месту» либо нарушила бы границу,
 * либо породила третью копию.
 *
 * ⚠️ Даты здесь `string`, хотя в домене они `Date`: это схема ОТВЕТА,
 * а в JSON дата — строка. Схема описывает то, что уходит в сеть.
 */
import * as v from 'valibot'

/** Строка заказа: что выдаём или принимаем. */
export const OrderLineSchema = v.object({
  id: v.pipe(v.string(), v.uuid()),
  kind: v.string(),
  variantId: v.nullable(v.pipe(v.string(), v.uuid())),
  variantCode: v.nullable(v.string()),
  variantName: v.nullable(v.string()),
  /** Название категории: на бумаге «42» без «Ботинки» не читается (18.8). */
  categoryName: v.nullable(v.string()),
  qty: v.number(),
  amount: v.nullable(v.string()),
  lineStatus: v.string(),
  /** Заполнено при поимённом учёте: какая именно вещь выдана. */
  itemId: v.nullable(v.pipe(v.string(), v.uuid())),
  labelCode: v.nullable(v.string()),
  /**
   * ⚠️ Рекомендация и ФАКТ — разные поля, и это железное правило 7:
   * система считает рекомендацию, а человек подтверждает значение.
   * Кто проверил и когда — тоже на строке.
   *
   * ⚠️ Тип `string`, а не `number`, и это проверено ответом, а не
   * выведено: колонка `din_actual` — `numeric`, драйвер отдаёт её
   * строкой, в JSON приходит `"6.5"`. Админская схема объявляла
   * `number()` — расхождение с фактом, незаметное потому, что схема
   * ответы не валидирует, а только описывает. Рядом `bootSoleLengthMm`
   * остаётся `number`: там колонка `integer`, и в JSON это `305`.
   */
  dinRecommended: v.nullable(v.string()),
  dinActual: v.nullable(v.string()),
  verifiedBy: v.nullable(v.string()),
  verifiedAt: v.nullable(v.string()),
  /** BSL: читается с ботинка при выдаче, не хранится за вещью (правило 8). */
  bootSoleLengthMm: v.nullable(v.number()),
  returnedAt: v.nullable(v.string()),
  conditionNote: v.nullable(v.string()),
})

/**
 * Клиент заказа.
 *
 * ⚠️ Сам объект ВСЕГДА есть — `null` бывают только его поля. Выдача без
 * брони оформляется без клиента, и `LEFT JOIN` даёт пустые значения, но
 * домен всё равно собирает объект с `?? null` в каждом поле (проверено
 * ответом: `{"id":null,"name":null,...,"noShowCount":0}`).
 *
 * Админская схема объявляла `nullable` на весь объект — и это не
 * безобидная перестраховка: 12 ошибок «customer возможно null» на трёх
 * экранах требовали бы дописать проверки на ветку, которой не бывает.
 * Обратная ложь — `phone: v.string()` при `LEFT JOIN` — стоила падения
 * списка стойки в 500, когда `phone.slice(-4)` встретил `null`.
 */
export const OrderCustomerSchema = v.object({
  id: v.nullable(v.pipe(v.string(), v.uuid())),
  name: v.nullable(v.string()),
  /**
   * ⚠️ Может быть `null`: выдача без брони оформляется без клиента, и
   * `LEFT JOIN` даёт пустые поля. Здесь стояло `v.string()` — тип лгал
   * ровно так же, как лгал он в домене, где `phone.slice(-4)` уронил
   * список стойки в 500.
   */
  phone: v.nullable(v.string()),
  email: v.nullable(v.string()),
  /** Сколько раз не пришёл: видно на стойке рядом с заказом. */
  noShowCount: v.number(),
  bodyParams: v.nullable(v.record(v.string(), v.unknown())),
})

/** Карточка заказа целиком (13.3). */
export const OrderDetailSchema = v.object({
  id: v.pipe(v.string(), v.uuid()),
  publicCode: v.string(),
  status: v.string(),
  branchName: v.string(),
  /** Адрес филиала и имя тенанта — стороны и место акта (18.8). */
  branchAddress: v.nullable(v.string()),
  tenantName: v.string(),
  branchId: v.pipe(v.string(), v.uuid()),
  timezone: v.string(),
  startsAt: v.string(),
  endsAt: v.string(),
  total: v.nullable(v.string()),
  /**
   * ⚠️ Снимок цены с разбором, а не ссылка на правило (железное
   * правило 6): иначе правка прайса переписала бы прошлые заказы.
   */
  priceBreakdown: v.nullable(v.record(v.string(), v.unknown())),
  confirmDeadline: v.nullable(v.string()),
  createdAt: v.string(),
  customer: OrderCustomerSchema,
  lines: v.array(OrderLineSchema),
  agreement: v.optional(v.nullable(v.object({
    signedAt: v.string(),
    offerVersion: v.string(),
    channel: v.nullable(v.string()),
  }))),
})
