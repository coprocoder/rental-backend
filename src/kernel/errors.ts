/**
 * Единый конверт ошибки на весь API.
 *
 * `message` — для человека, `code` — для кода: виджет реагирует на код,
 * а не парсит текст (тексты ещё и переводятся).
 * См. ../rental-docs/docs/04-тз/10-бэкенд/20-api.md
 *
 * ⚠️ В отличие от версии в Nuxt (`server/utils/errors.ts`), здесь НЕТ
 * зависимости от HTTP-фреймворка: `apiError` возвращает обычный объект
 * ошибки, а в ответ его превращает единственный обработчик в транспорте.
 * Это то, ради чего слой существует — домен и usecase бросают ошибки, не
 * зная, что снаружи HTTP.
 */
export type ApiErrorCode =
  | 'ITEM_JUST_TAKEN'
  | 'POOL_EXHAUSTED'
  | 'PRICE_CHANGED'
  | 'HOLD_EXPIRED'
  | 'LIMIT_EXCEEDED'
  | 'OUTSIDE_BUSINESS_HOURS'
  /** Категория не в сезоне на даты аренды: сноуборд на июль. */
  | 'OUT_OF_SEASON'
  /**
   * Предложение из листа ожидания уже недоступно (17.14).
   *
   * ⚠️ Отдельный код, а не INVALID_STATE: клиенту нужно показать
   * не «ошибка», а что именно случилось и что он всё ещё в очереди.
   */
  | 'WAITLIST_OFFER_LOST'
  | 'TENANT_SUSPENDED'
  | 'TENANT_NOT_FOUND'
  | 'RATE_LIMITED'
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  /** Переход статуса недопустим: «отменить возвращённый заказ». */
  | 'INVALID_STATE'
  | 'FORBIDDEN'
  /**
   * Функция недоступна на текущем тарифе.
   *
   * ⚠️ Отдельный код, а не FORBIDDEN: это не «вам нельзя», а «включите
   * тариф». Смешав их, мы отправляем прокат в поддержку выяснять, за
   * что его наказали, вместо того чтобы показать путь к решению.
   */
  | 'PLAN_REQUIRED'
  /**
   * Отсканирована вещь другой позиции.
   *
   * ⚠️ Отдельный код, а не VALIDATION_FAILED: сотруднику нужно не
   * «проверьте данные», а «это ботинки 42, а в заказе 44».
   */
  | 'ITEM_MISMATCH'
  /** Вещь уже на руках по другому заказу. */
  | 'ITEM_BUSY'
  /** Вещь списана со склада. */
  | 'ITEM_ARCHIVED'
  /**
   * Внешняя система недоступна — не путать с «данные неверны».
   *
   * ⚠️ Разделено намеренно: если недоступность Telegram показать как
   * «неверный токен», владелец начнёт перевыпускать рабочий ключ,
   * а проблема была в сети.
   */
  | 'UPSTREAM_UNAVAILABLE'
  | 'INTERNAL'

const STATUS: Record<ApiErrorCode, number> = {
  ITEM_JUST_TAKEN: 409,
  POOL_EXHAUSTED: 409,
  PRICE_CHANGED: 409,
  HOLD_EXPIRED: 410,
  LIMIT_EXCEEDED: 422,
  OUTSIDE_BUSINESS_HOURS: 422,
  OUT_OF_SEASON: 422,
  // 409: запрос понят и корректен, изменилось состояние на той стороне.
  WAITLIST_OFFER_LOST: 409,
  TENANT_SUSPENDED: 403,
  TENANT_NOT_FOUND: 404,
  RATE_LIMITED: 429,
  VALIDATION_FAILED: 422,
  NOT_FOUND: 404,
  INVALID_STATE: 409,
  FORBIDDEN: 403,
  // 402: запрос корректен, не хватает оплаченного тарифа.
  PLAN_REQUIRED: 402,
  // 409: запрос понят, изменилось состояние вещи на складе.
  ITEM_MISMATCH: 409,
  ITEM_BUSY: 409,
  ITEM_ARCHIVED: 409,
  // 502: наша сторона исправна, не отвечает внешняя.
  UPSTREAM_UNAVAILABLE: 502,
  INTERNAL: 500,
}

/**
 * Ошибка предметной области, которую транспорт умеет превратить в ответ.
 *
 * ⚠️ Класс, а не простой объект: `instanceof` — единственный надёжный
 * способ отличить её от случайного `TypeError` в обработчике ошибок.
 * Утиная проверка по полю `code` поймала бы заодно ошибки драйвера `pg`,
 * у которых `code` тоже есть, — и отдала бы клиенту `23505` как код API.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode
  readonly statusCode: number
  readonly details: Record<string, unknown> | undefined

  constructor(code: ApiErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.statusCode = STATUS[code]
    this.details = details
  }

  /** Тело ответа ровно в том виде, в котором его ждёт фронт и виджет. */
  toBody(): { error: { code: ApiErrorCode, message: string, details?: Record<string, unknown> } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    }
  }
}

export function apiError(
  code: ApiErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ApiError {
  return new ApiError(code, message, details)
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError
}

/**
 * Превращает нарушение инварианта БД в осмысленный код.
 *
 * ⚠️ 23P01 — самая частая ошибка в воронке бронирования. Она обязана
 * быть не «500», а ответом с альтернативами: иначе клиент уходит.
 *
 * ⚠️ 23514 (CHECK) намеренно НЕ отображается здесь в «не хватает единиц».
 * В Nuxt-версии так сделано, и это уже стоило дефекта: CHECK сработал на
 * ПРАЙСЕ, а прокат увидел сообщение про склад на экране про деньги
 * (19.23, `plans/07-НАЙДЕННОЕ.md` п.7). Общее отображение слишком грубое —
 * CHECK ловится на месте вызова, где известно, какое правило нарушено.
 */
export function mapDbError(err: unknown): unknown {
  const code = (err as { code?: string }).code
  if (code === '23P01') {
    return apiError('ITEM_JUST_TAKEN', 'Эту позицию только что забрали')
  }
  return err
}
