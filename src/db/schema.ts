/**
 * Схема БД. Обоснования решений — ../rental-docs/docs/04-тз/10-бэкенд/11-модель-данных.md.
 *
 * Железные правила, которые видны прямо здесь (CLAUDE.md):
 *   деньги — numeric, никогда float;
 *   интервалы — tstzrange, полуоткрытые [начало, конец);
 *   заказы — rental_order, не order (зарезервированное слово SQL);
 *   tenant_id в каждой таблице тенанта + RLS (drizzle/manual/0003_rls.sql);
 *   архивирование вместо удаления там, где на запись есть ссылки.
 *
 * ⚠️ Инварианты (EXCLUDE, CHECK, RLS) живут в drizzle/manual/*.sql —
 * через ORM их не выразить. Здесь только таблицы, типы и индексы.
 */
import { sql } from 'drizzle-orm'
import {
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'

/* ────────────────────────── типы ────────────────────────── */

/**
 * tstzrange — центральный тип домена: интервал аренды.
 * Полуоткрытый [начало, конец): возврат в 15:00 и выдача в 15:00
 * НЕ конфликтуют. Буфер на подготовку — расширением диапазона,
 * а не изменением оператора пересечения.
 */
export const tstzrange = customType<{ data: string }>({
  dataType: () => 'tstzrange',
})

/**
 * daterange — интервал ДНЕЙ, полуоткрытый `[from, to)`.
 *
 * ⚠️ Отдельно от tstzrange: отключение позиции задаётся календарными
 * днями («с 3 по 5 января»), а не моментами времени. Смешивать нельзя —
 * у них разная арифметика на границах.
 */
export const daterange = customType<{ data: string }>({
  dataType: () => 'daterange',
})

/** Деньги. Никогда не float: округление в float даёт расхождения в копейках. */
const money = (name: string) => numeric(name, { precision: 10, scale: 2 })

/* ────────────────────────── перечисления ────────────────────────── */

/** Что считать сутками в прайсе. Три модели дают разные счета на одном заказе. */
export const dayModeEnum = pgEnum('day_mode', ['calendar', 'rolling24', 'business_day'])

/**
 * Уровень учёта, выбирается ПО КАТЕГОРИИ, а не по складу.
 * count по умолчанию: прокат работает в день подключения, ничего не покупая.
 */
export const trackingEnum = pgEnum('tracking_mode', ['count', 'instance', 'labeled'])

/** Показывать ли наличие. unverified снимает барьер внедрения. */
export const inventoryModeEnum = pgEnum('inventory_mode', ['tracked', 'unverified'])

/**
 * Статусы заказа.
 * ⚠️ awaiting_stock — состояние, в котором заказ СУЩЕСТВУЕТ, но инвентарь
 * не удерживает: групповые заказы выше порога ждут подтверждения оператора.
 */
export const orderStatusEnum = pgEnum('order_status', [
  'draft',
  'awaiting_stock',
  'awaiting_confirm',
  'confirmed',
  'issued',
  'partially_returned',
  'returned',
  'expired',
  'no_show',
  'cancelled',
  'overdue',
  'lost',
])

export const orderLineKindEnum = pgEnum('order_line_kind', ['rental', 'service', 'deposit'])
export const orderLineStatusEnum = pgEnum('order_line_status', [
  'reserved',
  'picked_up',
  'returned',
  'cancelled',
  'lost',
])

/** Типы движений — из них суммируется физическое наличие. */
export const movementKindEnum = pgEnum('movement_kind', [
  'receipt',
  'issue',
  'return',
  'to_service',
  'from_service',
  'write_off',
  'stocktake',
])

/**
 * ⚠️ Причина обслуживания. Без неё «поточили» и «сломано крепление»
 * навсегда неразличимы, а список обслуживания не построить.
 */
export const serviceKindEnum = pgEnum('service_kind', [
  'drying',
  'sharpening',
  'wax',
  'repair',
  'inspection',
  'other',
])

export const staffRoleEnum = pgEnum('staff_role', ['owner', 'admin', 'counter', 'technician'])
export const messengerEnum = pgEnum('messenger', ['telegram', 'max'])
export const labelKindEnum = pgEnum('label_kind', ['none', 'qr', 'barcode', 'nfc', 'rfid'])
export const depositKindEnum = pgEnum('deposit_kind', ['card_hold', 'cash', 'document', 'none'])
export const consentKindEnum = pgEnum('consent_kind', ['personal_data', 'terms', 'save_params'])
export const outboxStatusEnum = pgEnum('outbox_status', ['pending', 'sent', 'failed', 'dead'])
export const reserveModeEnum = pgEnum('reserve_mode', ['percent', 'absolute'])

/**
 * Назначение токена доступа клиента.
 *
 * ⚠️ Разные токены на разные цели: утечка ссылки «посмотреть» не должна
 * давать возможность отменить заказ (../rental-docs/docs/04-тз/10-бэкенд/17-доступ-и-роли.md).
 */
export const orderTokenPurposeEnum = pgEnum('order_token_purpose', [
  'view',
  'confirm',
  'cancel',
  /** Код ПЭП: живёт минуты, а не до конца аренды. */
  'sign',
])

/* ────────────────────────── платформа ────────────────────────── */

export const plan = pgTable('plan', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  /** Лимиты плана: филиалы, инвентарь, брони в месяц, SMS. Проверяются в одном месте. */
  limits: jsonb('limits').notNull().default(sql`'{}'::jsonb`),
  pricePerMonth: money('price_per_month'),
  isActive: boolean('is_active').notNull().default(true),
})

export const tenant = pgTable('tenant', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  planId: uuid('plan_id').references(() => plan.id),
  /** Дата, до которой оплачено. Ограничения при неоплате считаются от неё. */
  paidUntil: timestamp('paid_until', { withTimezone: true }),
  /** ⚠️ Что считать сутками — влияет на весь движок цен. */
  dayMode: dayModeEnum('day_mode').notNull().default('calendar'),
  locale: text('locale').notNull().default('ru'),
  currency: text('currency').notNull().default('RUB'),
  /** Тема: ограниченный набор токенов, не произвольный CSS. */
  theme: jsonb('theme').notNull().default(sql`'{}'::jsonb`),
  /** Порог автоподтверждения: выше — заказ без удержания инвентаря. */
  groupThreshold: integer('group_threshold').notNull().default(6),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
})

export const branch = pgTable('branch', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id),
  name: text('name').notNull(),
  address: text('address'),
  /** ⚠️ Пояс у ФИЛИАЛА, не у тенанта: сеть может пересекать зоны. */
  timezone: text('timezone').notNull().default('Europe/Moscow'),
  /**
   * Период работы филиала месяцами: «зимний прокат летом закрыт целиком».
   * ⚠️ Независимая ось от сезона категории: филиал закрыт целиком, а
   * категория неактивна при работающем филиале. Не смешивать.
   */
  seasonFromMonth: integer('season_from_month'),
  seasonToMonth: integer('season_to_month'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
}, (t) => [index('branch_tenant_idx').on(t.tenantId)])

export const apiKey = pgTable('api_key', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id),
  /** pk_ — публичный, в вёрстке; sk_ — только сервер. */
  prefix: text('prefix').notNull(),
  hash: text('hash').notNull(),
  /** Список доменов для публичного ключа: проверка Origin. */
  origins: text('origins').array(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => [index('api_key_tenant_idx').on(t.tenantId)])

/* ────────────────────────── персонал ────────────────────────── */

export const staff = pgTable('staff', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id),
  email: text('email'),
  phone: text('phone'),
  passwordHash: text('password_hash'),
  name: text('name').notNull(),
  role: staffRoleEnum('role').notNull(),
  /** ⚠️ Массив: сотрудник может работать на двух точках. Пусто у owner и admin. */
  branchIds: uuid('branch_ids').array(),
  /** PIN для быстрого переключения на общем устройстве стойки. */
  pinHash: text('pin_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /** ⚠️ Архив, не удаление: иначе осиротеет запись «кто выставил DIN». */
  archivedAt: timestamp('archived_at', { withTimezone: true }),
}, (t) => [
  index('staff_tenant_idx').on(t.tenantId),
  unique('staff_tenant_email_uk').on(t.tenantId, t.email),
])

/**
 * Смена. ⚠️ Не обязательна: если не открыли — создаётся неявная на
 * филиал и день. Иначе нарушалось бы «система работает при небрежном учёте».
 */
export const shift = pgTable('shift', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id),
  branchId: uuid('branch_id').notNull().references(() => branch.id),
  openedBy: uuid('opened_by').references(() => staff.id),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  closedBy: uuid('closed_by').references(() => staff.id),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  cashOpen: money('cash_open'),
  cashClose: money('cash_close'),
  /** Неявная смена создана системой, а не человеком. */
  isImplicit: boolean('is_implicit').notNull().default(false),
  note: text('note'),
}, (t) => [index('shift_branch_idx').on(t.branchId, t.openedAt)])

/* ────────────────────────── инвентарь ────────────────────────── */

export const category = pgTable('category', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id),
  code: text('code').notNull(),
  /** Названия по языкам: {"ru": "...", "en": "..."}. Переводимость с v1. */
  name: jsonb('name').notNull(),
  /** ⚠️ Какие параметры тела спрашивать. Форма собирается из этого. */
  bodyParams: jsonb('body_params').notNull().default(sql`'[]'::jsonb`),
  /** count по умолчанию: оборудование не требуется. */
  tracking: trackingEnum('tracking').notNull().default('count'),
  /** Буфер между арендами в минутах. По умолчанию 0. */
  bufferMinutes: integer('buffer_minutes').notNull().default(0),
  /**
   * Сезон категории месяцами, включительно: зима 11→4, лето 5→9.
   * Оба null — круглый год. Проверяется против даты АРЕНДЫ, не визита.
   * Это и есть «сезонность данными»: сапборды на лето — строка, не релиз.
   * Семантика — shared/season.ts.
   */
  seasonFromMonth: integer('season_from_month'),
  seasonToMonth: integer('season_to_month'),
  sortOrder: integer('sort_order').notNull().default(0),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
}, (t) => [unique('category_tenant_code_uk').on(t.tenantId, t.code)])

/**
 * Вариант = категория + размерный бакет. Центральная абстракция:
 * бронируется «одна единица из варианта», а не конкретная вещь.
 */
export const inventoryVariant = pgTable('inventory_variant', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id),
  branchId: uuid('branch_id').notNull().references(() => branch.id),
  categoryId: uuid('category_id').notNull().references(() => category.id),
  code: text('code').notNull(),
  name: jsonb('name').notNull(),
  /** Размерный бакет: {"length_min": 155, "length_max": 159} или {"mondo": "27.5"}. */
  sizeBucket: jsonb('size_bucket').notNull().default(sql`'{}'::jsonb`),
  /** Гибкая сезонная кайма: waist_width_mm, flex, turn_radius_m. */
  attrs: jsonb('attrs').notNull().default(sql`'{}'::jsonb`),
  /** Показывать ли наличие. Переопределяет режим тенанта. */
  inventoryMode: inventoryModeEnum('inventory_mode').notNull().default('tracked'),
  /**
   * Порядок в размерной сетке.
   *
   * ⚠️ Из кода не выводится: сортировка по `code` даёт L, M, S для
   * шлемов — алфавит вместо размера. Порядок размеров — свойство
   * домена, а не побочный эффект имени, поэтому поле явное.
   */
  sortOrder: integer('sort_order').notNull().default(0),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
}, (t) => [
  unique('variant_tenant_code_uk').on(t.tenantId, t.code),
  index('variant_branch_idx').on(t.branchId, t.categoryId),
])

/** Экземпляр — только при tracking = instance или labeled. */
export const item = pgTable('item', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id),
  variantId: uuid('variant_id').notNull().references(() => inventoryVariant.id),
  /** Короткий человекочитаемый ID для ручного ввода: SB-0147. */
  labelCode: text('label_code'),
  labelKind: labelKindEnum('label_kind').notNull().default('none'),
  labelValue: text('label_value'),
  /** Заводской серийник — атрибут, не ключ: серийники не универсальны. */
  manufacturerSerial: text('manufacturer_serial'),
  /** Описание для различения без метки: цвет, износ. */
  description: text('description'),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
}, (t) => [
  index('item_variant_idx').on(t.variantId),
  unique('item_tenant_label_uk').on(t.tenantId, t.labelCode),
])

/**
 * Счётчик пула по дням — ОСНОВНОЙ механизм защиты от переполнения
 * при tracking = count. ⚠️ Наличие нельзя считать наивным SUM по
 * пересечению: брони на 3 и 10 февраля обе пересекают запрос «1–15»,
 * но никогда не сосуществуют.
 */
export const poolDay = pgTable('pool_day', {
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id),
  variantId: uuid('variant_id').notNull().references(() => inventoryVariant.id),
  day: date('day').notNull(),
  qtyBooked: integer('qty_booked').notNull().default(0),
  capacity: integer('capacity').notNull(),
}, (t) => [unique('pool_day_pk').on(t.variantId, t.day)])

/**
 * Журнал движений — источник физического наличия.
 * physical = сумма журнала, а не хранимое число: любое расхождение
 * объяснимо, видно операцию и автора.
 */
export const movement = pgTable('movement', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id),
  branchId: uuid('branch_id').notNull().references(() => branch.id),
  variantId: uuid('variant_id').notNull().references(() => inventoryVariant.id),
  itemId: uuid('item_id').references(() => item.id),
  kind: movementKindEnum('kind').notNull(),
  /** Знаковое количество: выдача −N, возврат +N. */
  qty: integer('qty').notNull(),
  /** ⚠️ Без причины «поточили» и «сломано» неразличимы. */
  serviceKind: serviceKindEnum('service_kind'),
  orderId: uuid('order_id'),
  shiftId: uuid('shift_id').references(() => shift.id),
  staffId: uuid('staff_id').references(() => staff.id),
  reason: text('reason'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('movement_variant_idx').on(t.variantId, t.occurredAt),
  index('movement_shift_idx').on(t.shiftId),
])

/** Ёмкость склада — второй ограниченный ресурс. Проверка в v2. */
export const branchCapacity = pgTable('branch_capacity', {
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id),
  branchId: uuid('branch_id').notNull().references(() => branch.id),
  categoryId: uuid('category_id').notNull().references(() => category.id),
  maxUnits: integer('max_units').notNull(),
}, (t) => [unique('branch_capacity_pk').on(t.branchId, t.categoryId)])

/**
 * Дневной счётчик ожидаемого поступления на склад филиала.
 *
 * ⚠️ Почему вторая таблица, а не CHECK по branch_capacity: подзапрос
 * в CHECK запрещён, поэтому max_units денормализован в строку дня.
 * branch_capacity — справочник, branch_capacity_day — счётчик.
 * Тот же приём, что с pool_day: инвариант живёт в БД, а не в запросе.
 *
 * ⏸ Проверка используется в v2, вместе с межфилиальными возвратами.
 */
export const branchCapacityDay = pgTable('branch_capacity_day', {
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id),
  branchId: uuid('branch_id').notNull().references(() => branch.id),
  categoryId: uuid('category_id').notNull().references(() => category.id),
  day: date('day').notNull(),
  /** Сколько единиц ожидается на складе в этот день. */
  qtyExpected: integer('qty_expected').notNull().default(0),
  /** Денормализовано из branch_capacity: CHECK не умеет подзапросы. */
  maxUnits: integer('max_units').notNull(),
}, (t) => [unique('branch_capacity_day_pk').on(t.branchId, t.categoryId, t.day)])

/** Резерв под оффлайн-выдачу. По умолчанию 0. */
export const branchOfflineReserve = pgTable('branch_offline_reserve', {
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id),
  branchId: uuid('branch_id').notNull().references(() => branch.id),
  categoryId: uuid('category_id').notNull().references(() => category.id),
  mode: reserveModeEnum('mode').notNull().default('percent'),
  value: integer('value').notNull().default(0),
}, (t) => [unique('offline_reserve_pk').on(t.branchId, t.categoryId)])

/* ────────────────────────── расписание ────────────────────────── */

export const schedule = pgTable('schedule', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id),
  branchId: uuid('branch_id').notNull().references(() => branch.id),
  /** 0–6, где 0 — воскресенье. NULL для исключений по дате. */
  weekday: integer('weekday'),
  /** Конкретная дата — исключение: праздник, санитарный день. */
  exceptionDate: date('exception_date'),
  /** Локальное время филиала, не UTC: иначе после перевода часов уедет. */
  opensAt: text('opens_at'),
  closesAt: text('closes_at'),
  isClosed: boolean('is_closed').notNull().default(false),
}, (t) => [index('schedule_branch_idx').on(t.branchId)])

/* ────────────────────────── подбор и цены ────────────────────────── */

export const fitRule = pgTable('fit_rule', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id),
  categoryId: uuid('category_id').notNull().references(() => category.id),
  /** Правило как данные: условия по параметрам тела → вариант. */
  rule: jsonb('rule').notNull(),
  /** ⚠️ Версия года чартов: ASTM отменил поправочные коэффициенты. */
  chartYear: integer('chart_year').notNull(),
  version: integer('version').notNull().default(1),
  isActive: boolean('is_active').notNull().default(true),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
}, (t) => [index('fit_rule_category_idx').on(t.categoryId)])

export const priceRule = pgTable('price_rule', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id),
  variantId: uuid('variant_id').references(() => inventoryVariant.id),
  categoryId: uuid('category_id').references(() => category.id),
  /** base — базовая ставка, modifier — скидка или надбавка поверх. */
  ruleKind: text('rule_kind').notNull(),
  /** Период действия правила. EXCLUDE запрещает пересечение однотипных. */
  valid: tstzrange('valid').notNull(),
  /** Сетка по дням: [0, 550, 550] — «первый день бесплатно». */
  dayRates: jsonb('day_rates'),
  amount: money('amount'),
  percent: integer('percent'),
  /** Условия применения: день недели, время начала, категория клиента. */
  conditions: jsonb('conditions').notNull().default(sql`'{}'::jsonb`),
  priority: integer('priority').notNull().default(100),
  /** false — применяется только если несложимых ещё не было. */
  stackable: boolean('stackable').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
}, (t) => [index('price_rule_variant_idx').on(t.variantId)])

/** Комплект — шаблон, раскрываемый в строки при расчёте. Не родительская строка. */
export const setTemplate = pgTable('set_template', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id),
  name: jsonb('name').notNull(),
  variantIds: uuid('variant_ids').array().notNull(),
  priceRuleId: uuid('price_rule_id').references(() => priceRule.id),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
})

/** Лимиты бронирования — настройка тенанта. */
export const bookingLimit = pgTable('booking_limit', {
  tenantId: uuid('tenant_id').primaryKey().references(() => tenant.id),
  /** Доля пула на один заказ, проценты. 30 по умолчанию. */
  poolSharePercent: integer('pool_share_percent').notNull().default(30),
  /** Максимум активных броней на телефон. */
  maxActiveOrders: integer('max_active_orders').notNull().default(5),
  /** Глубина бронирования вперёд, дни. */
  maxAdvanceDays: integer('max_advance_days').notNull().default(90),
  /** Дедлайн подтверждения, часы до начала. */
  confirmDeadlineHours: integer('confirm_deadline_hours').notNull().default(24),
  /** TTL корзины, минуты. */
  holdMinutes: integer('hold_minutes').notNull().default(20),
})

/* ────────────────────────── клиенты и заказы ────────────────────────── */

export const customer = pgTable('customer', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id),
  /** Ключ идентификации. Счётчик неявок без него сбрасывался бы. */
  phone: text('phone').notNull(),
  email: text('email'),
  name: text('name'),
  messenger: messengerEnum('messenger'),
  messengerChatId: text('messenger_chat_id'),
  /** Параметры тела — только при согласии «запомнить мои размеры». */
  bodyParams: jsonb('body_params'),
  noShowCount: integer('no_show_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique('customer_tenant_phone_uk').on(t.tenantId, t.phone)])

export const rentalOrder = pgTable('rental_order', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id),
  /** Короткий номер для поиска на стойке и в QR. */
  publicCode: text('public_code').notNull(),
  branchPickupId: uuid('branch_pickup_id').notNull().references(() => branch.id),
  branchReturnId: uuid('branch_return_id').references(() => branch.id),
  customerId: uuid('customer_id').references(() => customer.id),
  status: orderStatusEnum('status').notNull().default('draft'),
  period: tstzrange('period').notNull(),
  /** ⚠️ TTL корзины: минуты, защищает окно оформления. */
  holdExpiresAt: timestamp('hold_expires_at', { withTimezone: true }),
  /** ⚠️ Другое: сутки, защищает склад от блокировки будущими бронями. */
  confirmDeadline: timestamp('confirm_deadline', { withTimezone: true }),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  /** Снимок суммы: правила изменятся, а заказ должен показывать своё. */
  totalAmount: money('total_amount'),
  /** Разбивка: какие правила применились. Без неё нельзя ответить «почему 380». */
  priceBreakdown: jsonb('price_breakdown'),
  /** Срок обезличивания ПД. */
  retentionUntil: timestamp('retention_until', { withTimezone: true }),
  shiftId: uuid('shift_id').references(() => shift.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('order_tenant_code_uk').on(t.tenantId, t.publicCode),
  index('order_status_idx').on(t.tenantId, t.status),
  index('order_branch_idx').on(t.branchPickupId),
])

export const orderLine = pgTable('order_line', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id),
  orderId: uuid('order_id').notNull().references(() => rentalOrder.id),
  kind: orderLineKindEnum('kind').notNull().default('rental'),
  variantId: uuid('variant_id').references(() => inventoryVariant.id),
  /** NULL при tracking = count. Заполняется только для экземпляров. */
  itemId: uuid('item_id').references(() => item.id),
  qty: integer('qty').notNull().default(1),
  /** Интервал строки: EXCLUDE по (item_id, period) запрещает двойную бронь. */
  period: tstzrange('period'),
  status: orderLineStatusEnum('status').notNull().default('reserved'),
  amount: money('amount'),
  /** Пометка, что цена пришла из комплекта, а не из отдельной позиции. */
  fromSetId: uuid('from_set_id').references(() => setTemplate.id),
  /** ⚠️ BSL читается с ботинка при выдаче, не хранится на экземпляре. */
  bootSoleLengthMm: integer('boot_sole_length_mm'),
  dinRecommended: numeric('din_recommended', { precision: 3, scale: 1 }),
  /** Фактически выставленное значение — след ответственности. */
  dinActual: numeric('din_actual', { precision: 3, scale: 1 }),
  verifiedBy: uuid('verified_by').references(() => staff.id),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  returnedAt: timestamp('returned_at', { withTimezone: true }),
  conditionNote: text('condition_note'),
}, (t) => [
  index('order_line_order_idx').on(t.orderId),
  index('order_line_item_idx').on(t.itemId),
])

/** Лист ожидания. ⚠️ Инвентарь НЕ блокирует — им нельзя захватить арсенал. */
export const waitlist = pgTable('waitlist', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id),
  branchId: uuid('branch_id').notNull().references(() => branch.id),
  variantId: uuid('variant_id').notNull().references(() => inventoryVariant.id),
  customerId: uuid('customer_id').notNull().references(() => customer.id),
  period: tstzrange('period').notNull(),
  /** Очередь строго по времени записи: объективный критерий. */
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  notifiedAt: timestamp('notified_at', { withTimezone: true }),
  status: text('status').notNull().default('waiting'),
  /**
   * Гонка нескольких за одно освобождение (17.14).
   *
   * ⚠️ Победитель определяется уникальным индексом
   * `waitlist_one_winner_uk`, а не проверкой в коде: два обработчика
   * прочитали бы «свободно» одновременно и оба создали заказ
   * (железное правило №2). Ключ описывает конкретное освобождение —
   * вариант и интервал; забрать его может ровно один.
   */
  releaseKey: text('release_key'),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  /**
   * Право забрать предложение: без токена чужое забирает любой,
   * кто знает id.
   *
   * ⚠️ Только sha256, как в order_token: сам токен живёт в ссылке
   * и в БД не восстанавливается.
   */
  offerTokenHash: text('offer_token_hash'),
  /**
   * «Любая дата в диапазоне» (17.14): где клиент согласен взять.
   *
   * ⚠️ Отдельно от period, а не расширением его: period — что
   * арендуют (двое суток), search_period — в каких пределах искать
   * (неделя). NULL — нужны ровно эти даты, прежнее поведение.
   */
  searchPeriod: tstzrange('search_period'),
  /** Сколько суток нужно — чтобы подобрать окно внутри диапазона. */
  nights: integer('nights'),
}, (t) => [index('waitlist_variant_idx').on(t.variantId, t.createdAt)])

/* ────────────────────────── деньги (используется после v1) ────────────────────────── */

export const payment = pgTable('payment', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id),
  orderId: uuid('order_id').notNull().references(() => rentalOrder.id),
  provider: text('provider').notNull(),
  externalId: text('external_id'),
  amount: money('amount').notNull(),
  status: text('status').notNull().default('created'),
  /** ⚠️ Ключ идемпотентности: вебхук может прийти дважды. */
  idempotencyKey: text('idempotency_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique('payment_idem_uk').on(t.tenantId, t.idempotencyKey)])

/** ⚠️ Чек — отдельная сущность: платёж мог пройти, а чек не выбиться. */
export const receipt = pgTable('receipt', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id),
  orderId: uuid('order_id').notNull().references(() => rentalOrder.id),
  paymentId: uuid('payment_id').references(() => payment.id),
  provider: text('provider').notNull(),
  /** sale или refund: возврат — тоже чек, а не смена статуса. */
  kind: text('kind').notNull(),
  status: text('status').notNull().default('queued'),
  fiscalData: jsonb('fiscal_data'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const deposit = pgTable('deposit', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id),
  orderId: uuid('order_id').notNull().references(() => rentalOrder.id),
  kind: depositKindEnum('kind').notNull().default('none'),
  amount: money('amount'),
  status: text('status').notNull().default('created'),
  /** ⚠️ Списание залога — это расчёт, значит требует чека. */
  capturedAmount: money('captured_amount'),
  documentNote: text('document_note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/* ────────────────────────── договор и согласия ────────────────────────── */

export const agreement = pgTable('agreement', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id),
  orderId: uuid('order_id').notNull().references(() => rentalOrder.id),
  /** Версия текста: старые заказы ссылаются на свою редакцию. */
  offerVersion: text('offer_version').notNull(),
  offerHash: text('offer_hash').notNull(),
  signedAt: timestamp('signed_at', { withTimezone: true }).notNull().defaultNow(),
  /** Канал кода: в MVP мессенджер, не SMS. */
  signChannel: text('sign_channel'),
  phone: text('phone'),
  ip: text('ip'),
  messengerChatId: text('messenger_chat_id'),
})

export const consent = pgTable('consent', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id),
  orderId: uuid('order_id').references(() => rentalOrder.id),
  customerId: uuid('customer_id').references(() => customer.id),
  kind: consentKindEnum('kind').notNull(),
  textVersion: text('text_version').notNull(),
  /** ⚠️ Чекбокс без записи в БД ничего не доказывает. */
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  ip: text('ip'),
  userAgent: text('user_agent'),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
})

/**
 * Токены доступа клиента к своему заказу.
 *
 * Клиент не регистрируется: доступ даётся ссылкой из уведомления.
 * Требования — ../rental-docs/docs/04-тз/10-бэкенд/17-доступ-и-роли.md:
 *
 *   длинный случайный токен, НЕ производный от id заказа — иначе
 *   перебором читаются чужие заказы;
 *   разный токен на каждую цель;
 *   срок жизни до конца аренды плюс 30 дней;
 *   подтверждение идемпотентно: повторное нажатие — «уже подтверждено»,
 *   а не ошибка, потому что люди жмут дважды.
 *
 * ⚠️ Хранится ХЕШ, а не сам токен: дамп базы не должен давать доступ
 * к заказам клиентов. Сам токен существует только в ссылке.
 *
 * ⚠️ Токен не логируется целиком и вырезается из Referer — иначе
 * доступ к персональным данным осядет в чужой аналитике.
 */
export const orderToken = pgTable('order_token', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id),
  orderId: uuid('order_id').notNull().references(() => rentalOrder.id),
  purpose: orderTokenPurposeEnum('purpose').notNull(),
  /** sha256 от токена. Сам токен в БД не попадает. */
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  /** Когда по токену совершили действие. Для confirm — след идемпотентности. */
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // Поиск идёт по хешу: это точка входа запроса.
  unique('order_token_hash_uk').on(t.tokenHash),
  index('order_token_order_idx').on(t.orderId, t.purpose),
])

export const file = pgTable('file', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id),
  /** inventory_photo, damage_before, damage_after, contract_scan. */
  kind: text('kind').notNull(),
  orderId: uuid('order_id').references(() => rentalOrder.id),
  itemId: uuid('item_id').references(() => item.id),
  s3Key: text('s3_key').notNull(),
  mimeType: text('mime_type'),
  sizeBytes: integer('size_bytes'),
  /** ⚠️ Сканы договоров содержат ПД и лежат вне RLS: доступ по подписанным ссылкам. */
  retentionUntil: timestamp('retention_until', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/* ────────────────────────── журналы ────────────────────────── */

/**
 * Журнал доменных событий. Отвечает на «что произошло с заказом и в каком
 * порядке» — на это не отвечают ни movement, ни audit_log.
 * ⚠️ Пишется в ТОЙ ЖЕ транзакции, что изменение состояния.
 * Это НЕ event sourcing: состояние остаётся в обычных таблицах.
 */
export const event = pgTable('event', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id),
  aggregateType: text('aggregate_type').notNull(),
  aggregateId: uuid('aggregate_id').notNull(),
  kind: text('kind').notNull(),
  payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
  /** Проходит через все операции запроса: без него отладка — угадывание. */
  correlationId: uuid('correlation_id'),
  actorType: text('actor_type'),
  actorId: uuid('actor_id'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('event_aggregate_idx').on(t.aggregateType, t.aggregateId, t.occurredAt),
  index('event_correlation_idx').on(t.correlationId),
])

/**
 * Outbox: внешние эффекты не отправляются из транзакции.
 * ⚠️ Redis-очередь это НЕ заменяет: Redis не участвует в транзакции Postgres.
 * Доставка «хотя бы один раз» → обработчик отправки идемпотентен.
 */
export const outbox = pgTable('outbox', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id),
  kind: text('kind').notNull(),
  payload: jsonb('payload').notNull(),
  status: outboxStatusEnum('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  idempotencyKey: text('idempotency_key').notNull(),
  correlationId: uuid('correlation_id'),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
}, (t) => [
  unique('outbox_idem_uk').on(t.tenantId, t.idempotencyKey),
  index('outbox_pending_idx').on(t.status, t.nextAttemptAt),
])

/** Ручные вмешательства с автором и причиной. По файлам это не ищется. */
export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id),
  staffId: uuid('staff_id').references(() => staff.id),
  action: text('action').notNull(),
  targetType: text('target_type').notNull(),
  targetId: uuid('target_id'),
  /** ⚠️ Причина обязательна: иначе через месяц не разобрать. */
  reason: text('reason'),
  before: jsonb('before'),
  after: jsonb('after'),
  correlationId: uuid('correlation_id'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('audit_target_idx').on(t.targetType, t.targetId)])

/**
 * Агрегаты спроса без ПД. ⚠️ Копятся с первого дня, ещё до появления
 * отчётов: задача обезличивания стирает параметры тела, и если считать
 * «когда понадобятся» — истории уже не будет.
 */
export const demandDaily = pgTable('demand_daily', {
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id),
  branchId: uuid('branch_id').notNull().references(() => branch.id),
  day: date('day').notNull(),
  variantId: uuid('variant_id').references(() => inventoryVariant.id),
  /** Размерный бакет вместо параметров конкретного человека. */
  sizeBucket: text('size_bucket'),
  /** Причина отказа: не только «нет наличия», но и часы, лимит, уход. */
  reasonCode: text('reason_code'),
  requests: integer('requests').notNull().default(0),
  fulfilled: integer('fulfilled').notNull().default(0),
  rejected: integer('rejected').notNull().default(0),
  estLostRevenue: money('est_lost_revenue'),
}, (t) => [
  unique('demand_daily_pk').on(t.branchId, t.day, t.variantId, t.sizeBucket, t.reasonCode),
])


/* ────────── сессии и вход сотрудников (ручной SQL 0008) ────────── */

/**
 * ⚠️ Эти пять таблиц создаются ручными миграциями, но ДОЛЖНЫ быть
 * описаны здесь: `drizzle-kit generate` строит diff от этого файла,
 * и невидимая ему таблица однажды попадёт в сгенерированный `DROP`.
 * Защитой было только внимание человека при ревью — этого мало,
 * когда речь о живых сессиях сотрудников и текстах оферты.
 */
export const staffSession = pgTable('staff_session', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id),
  staffId: uuid('staff_id').notNull().references(() => staff.id),
  /** sha256 токена: дамп базы не должен давать доступ к сессиям. */
  tokenHash: text('token_hash').notNull(),
  /** Кто работает сейчас — меняется PIN-переключением на общем устройстве. */
  activeStaffId: uuid('active_staff_id').references(() => staff.id),
  ip: text('ip'),
  userAgent: text('user_agent'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Попытки входа — для блокировки перебора.
 *
 * ⚠️ tenant_id НУЛЛИМЫЙ: неудачная попытка с неизвестным email
 * происходит до того, как тенант определён. Политика RLS это
 * учитывает отдельной веткой.
 */
export const staffLoginAttempt = pgTable('staff_login_attempt', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenant.id),
  email: text('email').notNull(),
  ip: text('ip'),
  succeeded: boolean('succeeded').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('staff_login_attempt_email_idx').on(t.email, t.occurredAt)])

/* ────────── юридические тексты (ручной SQL 0012) ────────── */

/**
 * Оферта, политика ПД и правила проката.
 *
 * ⚠️ Версионируются: у согласия клиента должно быть зафиксировано,
 * с КАКОЙ редакцией он согласился. Активная версия одна на вид —
 * это частичный уникальный индекс в БД, а не проверка в коде.
 */
export const tenantText = pgTable('tenant_text', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id),
  /** offer | privacy | rules — ограничено CHECK в миграции. */
  kind: text('kind').notNull(),
  version: integer('version').notNull(),
  body: text('body').notNull(),
  /** Хеш текста: по нему согласие связывается с конкретной редакцией. */
  hash: text('hash').notNull(),
  isActive: boolean('is_active').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by').references(() => staff.id),
}, (t) => [
  unique('tenant_text_version_uq').on(t.tenantId, t.kind, t.version),
  index('tenant_text_lookup').on(t.tenantId, t.kind, t.createdAt),
])

/* ────────── рубильники функций (ручной SQL 0013) ────────── */

/**
 * ⚠️ Ставит ПЛАТФОРМА, а не тенант: смысл в том, чтобы поддержка
 * могла погасить функцию у конкретного проката. Поэтому у таблицы
 * нет RLS и нет прав на запись у прикладной роли.
 */
export const tenantFlag = pgTable('tenant_flag', {
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id),
  flag: text('flag').notNull(),
  enabled: boolean('enabled').notNull(),
  /** Причина обязательна: рубильник без объяснения не снять осознанно. */
  reason: text('reason').notNull(),
  until: timestamp('until', { withTimezone: true }),
  setBy: uuid('set_by').references(() => staff.id),
  setAt: timestamp('set_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('tenant_flag_pk').on(t.tenantId, t.flag),
  index('tenant_flag_lookup').on(t.tenantId, t.until),
])

/* ────────── отключение позиции на даты (ручной SQL 0015) ────────── */

/**
 * Четвёртая ось недоступности рядом с сезоном, расписанием и пулом:
 * «эта позиция недоступна 3–5 января» (18.2).
 *
 * ⚠️ Счётчики пула не трогает: пул отвечает «сколько физически есть»,
 * отключение — «продавать ли». Смешение потеряло бы реальные брони
 * при снятии отключения.
 */
/**
 * Отключение КОНКРЕТНОЙ единицы на даты.
 *
 * ⚠️ Отдельно от `variant_blackout`, потому что смысл разный:
 * отключение позиции обнуляет пул («сапборды не сдаём в ноябре»),
 * отключение вещи уменьшает ёмкость на единицу («этот ботинок
 * в ремонте до пятницы») — остальные пары обязаны продолжать
 * продаваться.
 */
export const itemBlackout = pgTable('item_blackout', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id),
  itemId: uuid('item_id').notNull().references(() => item.id),
  /** Полуоткрытый [from, to): «по 5 января» хранится как to = 6-е. */
  days: daterange('days').notNull(),
  reason: text('reason').notNull(),
  createdBy: uuid('created_by').references(() => staff.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('item_blackout_tenant_idx').on(t.tenantId),
  index('item_blackout_item_idx').on(t.itemId),
])

export const variantBlackout = pgTable('variant_blackout', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id),
  variantId: uuid('variant_id').notNull().references(() => inventoryVariant.id),
  /** Полуоткрытый [from, to): «по 5 января» хранится как to = 6-е. */
  days: daterange('days').notNull(),
  reason: text('reason').notNull(),
  createdBy: uuid('created_by').references(() => staff.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('variant_blackout_tenant_idx').on(t.tenantId)])
