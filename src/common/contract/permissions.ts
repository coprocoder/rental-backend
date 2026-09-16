/**
 * Права и роли: единственный источник правды для фронта и бэка.
 *
 * Спека: ../rental-docs/docs/04-тз/10-бэкенд/17-доступ-и-роли.md
 *
 * ⚠️ Лежит в `shared/`, а не в домене, потому что нужен ОБЕИМ сторонам:
 * сервер решает доступ, меню решает, что показать. Раньше матрица была
 * скопирована во фронт с пометкой «зеркало server/domain/auth.ts» —
 * две копии расходятся на первой же правке, и расхождение это либо
 * пункт меню, ведущий в 403, либо спрятанный экран, к которому доступ
 * на самом деле есть.
 *
 * ⚠️ Четыре ФИКСИРОВАННЫЕ роли, а не конструктор прав. Конструктор даёт
 * ошибки настройки, вопросы в поддержку и невозможность ответить
 * «а почему он это смог».
 *
 * ⚠️ Скрытый пункт меню — это удобство, а НЕ граница доступа. Границу
 * держит сервер: каждый эндпоинт зовёт `requirePermission`. Права здесь
 * лишь описывают, что показывать.
 */

export type StaffRole = 'owner' | 'admin' | 'counter' | 'technician'

/* ─────────────────────── права по областям ─────────────────────── */

/**
 * Заказы: вопросы очереди. Клиент стоит у стойки — надо решить сейчас.
 * Поэтому здесь щедрее всего: эти права есть даже у стойки.
 */
export const ORDER_PERMISSIONS = [
  /** Выдать, когда журнал говорит «свободных нет», а вещь на полке. */
  'order.issue_on_mismatch',
  'order.cancel',
  'order.confirm',
  'order.extend',
  /** Снять отметку о неявке: клиент опоздал, но пришёл. */
  'noshow.clear',
  /** Превысить лимит броней на клиента или долю пула. */
  'limit.override',
] as const

/**
 * Деньги: скидки, залоги, прайс, выручка.
 *
 * ⚠️ Отделены от заказов намеренно: стойка решает, выдавать ли вещь,
 * но не решает, за сколько. Это защищает и от ошибок в спешке,
 * и от злоупотреблений, не мешая работе в пик.
 */
export const MONEY_PERMISSIONS = [
  'prepay.waive',
  /** Изменить цену в заказе руками — всегда с причиной в audit_log. */
  'price.override',
  'deposit.charge',
  'price.manage',
  'reports.revenue',
] as const

/** Инвентарь: что есть на складе и что с ним стало. */
export const INVENTORY_PERMISSIONS = [
  'inventory.manage',
  /** Списать: вещь сломана или потеряна. */
  'inventory.write_off',
] as const

/**
 * Настройки тенанта: сотрудники, интеграции, тариф.
 *
 * ⚠️ Именно этого у администратора НЕТ — по ТЗ он не заводит
 * сотрудников, не видит ключи интеграций и не меняет тариф.
 * Ключи это доступ к деньгам проката, а тариф — счёт, который
 * платит владелец.
 */
export const SETTINGS_PERMISSIONS = [
  /** Сотрудники, тексты, тема — всё, что меняет облик и состав. */
  'staff.manage',
  'integrations.manage',
  'plan.manage',
] as const

/**
 * Работы с инвентарём: обслуживание и настройка креплений.
 *
 * ⚠️ Есть у ВСЕХ ролей, включая техника, у которого больше нет ничего:
 * запись DIN — след ответственности, и она должна быть доступна тому,
 * кто крепления реально проверил.
 */
export const WORK_PERMISSIONS = [
  'service.record',
  'din.record',
] as const

export const PERMISSION_GROUPS = {
  orders: ORDER_PERMISSIONS,
  money: MONEY_PERMISSIONS,
  inventory: INVENTORY_PERMISSIONS,
  settings: SETTINGS_PERMISSIONS,
  work: WORK_PERMISSIONS,
} as const

export type Permission =
  | (typeof ORDER_PERMISSIONS)[number]
  | (typeof MONEY_PERMISSIONS)[number]
  | (typeof INVENTORY_PERMISSIONS)[number]
  | (typeof SETTINGS_PERMISSIONS)[number]
  | (typeof WORK_PERMISSIONS)[number]

/** Человеческое описание — для экрана сотрудников и отладки. */
export const PERMISSION_LABELS: Record<Permission, string> = {
  'order.issue_on_mismatch': 'Выдать при расхождении наличия',
  'order.cancel': 'Отменить бронь',
  'order.confirm': 'Подтвердить бронь',
  'order.extend': 'Продлить аренду',
  'noshow.clear': 'Снять отметку о неявке',
  'limit.override': 'Превысить лимиты брони',
  'prepay.waive': 'Снять требование предоплаты',
  'price.override': 'Изменить цену в заказе',
  'deposit.charge': 'Списать залог за ущерб',
  'price.manage': 'Управлять прайсом и услугами',
  'reports.revenue': 'Смотреть выручку и отчёты',
  'inventory.manage': 'Управлять инвентарём',
  'inventory.write_off': 'Списывать инвентарь',
  'staff.manage': 'Сотрудники, тексты, оформление',
  'integrations.manage': 'Ключи интеграций',
  'plan.manage': 'Тариф и подписка',
  'service.record': 'Отмечать обслуживание',
  'din.record': 'Записывать фактический DIN',
}

/* ─────────────────────────── роли ─────────────────────────── */

/**
 * Роли собираются ИЗ БЛОКОВ, а не перечислением 18 строк.
 *
 * ⚠️ Так разница между ролями видна одним взглядом: у стойки нет
 * денег и инвентаря, у техника только работы. Перечисление руками
 * гарантировало обратное — при добавлении права его забывали
 * в одной из ролей, и понять это можно было только сравнив
 * два длинных списка построчно.
 */
export const ROLE_PERMISSIONS: Record<StaffRole, readonly Permission[]> = {
  /** Владелец: всё. */
  owner: [
    ...ORDER_PERMISSIONS,
    ...MONEY_PERMISSIONS,
    ...INVENTORY_PERMISSIONS,
    ...SETTINGS_PERMISSIONS,
    ...WORK_PERMISSIONS,
  ],

  /**
   * Администратор: работа проката целиком, кроме настроек тенанта.
   *
   * ⚠️ Отсутствие SETTINGS_PERMISSIONS — это решение из ТЗ, а не
   * недосмотр: сотрудники, ключи интеграций и тариф остаются
   * владельцу. Отсюда же и скрытый блок «Настройка» в меню.
   */
  admin: [
    ...ORDER_PERMISSIONS,
    ...MONEY_PERMISSIONS,
    ...INVENTORY_PERMISSIONS,
    ...WORK_PERMISSIONS,
  ],

  /** Стойка: очередь — да, деньги и инвентарь — нет. */
  counter: [
    ...ORDER_PERMISSIONS,
    'din.record',
  ],

  /** Техник: только обслуживание и DIN. Заказы и деньги — нет. */
  technician: [...WORK_PERMISSIONS],
}

/** Есть ли у роли право. Единственная проверка на обеих сторонах. */
export function roleCan(role: StaffRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false
}
