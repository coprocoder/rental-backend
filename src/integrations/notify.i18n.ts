/**
 * Тексты уведомлений — данными, с версией и языком.
 *
 * ⚠️ Почему не строки в коде (../rental-docs/docs/04-тз/10-бэкенд/16-уведомления.md):
 * тенанту нужно править формулировки под себя, а версия текста нужна
 * юридически — в consent пишется, какую именно редакцию видел клиент.
 *
 * Здесь дефолтные тексты платформы. Тенант переопределяет их в админке,
 * структура одна и та же. Русский обязателен, английский — заготовка
 * под мультиязычность (интерфейс на en — после v1, но структура
 * закладывается сразу, чтобы не переписывать все обработчики).
 *
 * ⚠️ Формулировки не случайны:
 *   отмена ПООЩРЯЕТСЯ — освободившийся инвентарь продаётся снова,
 *   поэтому ссылка на отмену видна сразу и без «вы уверены?»;
 *   крупный заказ называется ЗАКАЗОМ, а не заявкой: клиент получил
 *   номер, его услышали (см. порог автоподтверждения в ТЗ).
 */

export const TEMPLATE_VERSION = 'v1'

export type TemplateKey =
  | 'order_created'
  | 'order_created_group'
  | 'confirm_reminder'
  | 'order_confirmed'
  | 'order_expired'
  | 'waitlist_available'
  | 'sign_code'

interface Template {
  subject: string
  text: string
}

/** Подстановка {{var}}. Отсутствующие переменные удаляются. */
function fill(tpl: string, vars: Record<string, string>): string {
  return tpl
    .replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? '')
    // Схлопываем пустые строки, оставшиеся от пропущенных переменных.
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const RU: Record<TemplateKey, Template> = {
  order_created: {
    subject: 'Заказ {{code}} принят — подтвердите бронь',
    text: `Здравствуйте!

Заказ {{code}} принят. Чтобы снаряжение осталось за вами, подтвердите бронь:
{{confirmUrl}}

Если планы изменятся, отмените заказ — так снаряжение достанется другому:
{{cancelUrl}}

Посмотреть заказ: {{viewUrl}}

{{telegramLine}}`,
  },

  order_created_group: {
    subject: 'Заказ {{code}} принят — проверяем наличие',
    text: `Здравствуйте!

Заказ {{code}} принят. Он крупный, поэтому наличие проверит сотрудник
и свяжется с вами. Пока снаряжение за вами не закреплено.

Посмотреть заказ: {{viewUrl}}
Отменить: {{cancelUrl}}`,
  },

  confirm_reminder: {
    subject: 'Подтвердите бронь {{code}}',
    text: `Напоминаем: бронь {{code}} ждёт подтверждения.

Подтвердите до {{deadline}}, иначе снаряжение вернётся в продажу:
{{confirmUrl}}`,
  },

  order_confirmed: {
    subject: 'Бронь {{code}} подтверждена',
    text: `Бронь {{code}} подтверждена. Ждём вас!

Если планы изменятся, отмените заранее — снаряжение достанется другому.`,
  },

  order_expired: {
    subject: 'Бронь {{code}} снята',
    text: `Бронь {{code}} снята: подтверждения не было.

Снаряжение вернулось в продажу. Если поездка в силе, оформите заказ снова —
мы будем рады.`,
  },

  sign_code: {
    subject: 'Код подтверждения: {{code}}',
    // ⚠️ Формулировка нейтральная и без «никому не сообщайте»: код
    // подтверждает согласие с офертой, а не доступ к деньгам.
    text: `Код для подписания договора проката: {{code}}

Действует {{minutes}} мин. Если вы не оформляли заказ, просто
не вводите код.`,
  },

  waitlist_available: {
    subject: 'Освободилось: {{variant}}',
    text: `{{variant}} освободился на нужные вам даты.

Забронировать: {{bookUrl}}

⚠️ Успейте за {{minutes}} мин — дальше предложение уходит следующему
в очереди. Очередь по времени записи, одинаково для всех.`,
  },
}

/**
 * Английские тексты — заготовка.
 *
 * ⚠️ Не машинный перевод «на потом»: если ключа нет, renderTemplate
 * берёт русский, а не отдаёт пустую строку. Молчащее уведомление хуже
 * уведомления на другом языке, потому что на нём держится защита
 * инвентаря.
 */
const EN: Partial<Record<TemplateKey, Template>> = {
  order_created: {
    subject: 'Order {{code}} received — please confirm',
    text: `Hello!

Order {{code}} is received. Confirm your booking to keep the gear reserved:
{{confirmUrl}}

If your plans change, please cancel so someone else can take it:
{{cancelUrl}}

View order: {{viewUrl}}`,
  },
  confirm_reminder: {
    subject: 'Please confirm booking {{code}}',
    text: `Booking {{code}} is still awaiting confirmation.

Confirm before {{deadline}} or the gear goes back on sale:
{{confirmUrl}}`,
  },
}

const CATALOG: Record<string, Partial<Record<TemplateKey, Template>>> = {
  ru: RU,
  en: EN,
}

export function renderTemplate(
  key: TemplateKey,
  locale: string,
  vars: Record<string, string>,
): { subject: string, text: string, version: string } {
  // Падение на русский, а не на пустоту: см. комментарий к EN.
  const tpl = CATALOG[locale]?.[key] ?? RU[key]

  return {
    subject: fill(tpl.subject, vars),
    text: fill(tpl.text, vars),
    version: TEMPLATE_VERSION,
  }
}
