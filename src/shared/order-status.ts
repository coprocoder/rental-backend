/**
 * Человеческие названия и тон статусов заказа.
 *
 * ⚠️ Живёт в shared/, потому что нужно на трёх витринах сразу: клиенту
 * в его заказе, стойке и админке. Копия в каждой разошлась бы с
 * остальными на первой же правке — а расхождение здесь означает, что
 * сотрудник и клиент видят одно состояние под разными названиями и
 * спорят по телефону.
 *
 * ⚠️ Тон подбирается по смыслу для СОТРУДНИКА: «просрочен» красный не
 * потому, что клиент плохой, а потому что вещь не вернулась и её нельзя
 * выдать следующему.
 */
type OrderTone = 'neutral' | 'brand' | 'ok' | 'warn' | 'danger'

const STATUS: Record<string, { label: string, tone: OrderTone }> = {
  draft: { label: 'Черновик', tone: 'neutral' },
  awaiting_confirm: { label: 'Ждёт подтверждения', tone: 'warn' },
  confirmed: { label: 'Подтверждён', tone: 'brand' },
  // Ждёт поступления: групповая заявка больше порога, инвентарь
  // придержан не автоматом, а решением проката.
  awaiting_stock: { label: 'Ждёт наличия', tone: 'warn' },
  issued: { label: 'Выдан', tone: 'ok' },
  partially_returned: { label: 'Частично возвращён', tone: 'warn' },
  returned: { label: 'Возвращён', tone: 'neutral' },
  overdue: { label: 'Просрочен', tone: 'danger' },
  cancelled: { label: 'Отменён', tone: 'neutral' },
  expired: { label: 'Истёк', tone: 'neutral' },
  no_show: { label: 'Не пришёл', tone: 'danger' },
}

export function statusLabel(status: string): string {
  return STATUS[status]?.label ?? status
}

export function statusTone(status: string): OrderTone {
  return STATUS[status]?.tone ?? 'neutral'
}

/** Статусы, при которых заказ ещё держит инвентарь — для фильтров. */
export const ACTIVE_STATUSES = [
  'awaiting_confirm', 'confirmed', 'awaiting_stock', 'issued',
  'partially_returned', 'overdue',
]

/**
 * Человеческие названия событий хронологии заказа.
 *
 * ⚠️ Неизвестный вид события показывается КАК ЕСТЬ, а не прячется:
 * хронология — это доказательство того, что произошло, и молча
 * выброшенная строка превращает её в редактированную версию событий.
 * Новый вид события появится раньше, чем его перевод, и это нормально.
 */
const EVENT_LABELS: Record<string, string> = {
  'order.created': 'Заказ создан',
  'order.confirmed': 'Подтверждён клиентом',
  'order.cancelled': 'Отменён',
  'order.expired': 'Истёк срок подтверждения',
  'order.issued': 'Выдан на стойке',
  'order.returned': 'Возвращён',
  'order.partially_returned': 'Возвращён частично',
  'order.overdue': 'Признан просроченным',
  'order.extended': 'Продлён',
  'order.no_show': 'Клиент не пришёл',
  'order.transferred': 'Передан в другой филиал',
  'order.awaiting_stock': 'Отложен до наличия',
  'customer.telegram_linked': 'Клиент подключил Telegram',
  'customer.max_linked': 'Клиент подключил MAX',
  'agreement.signed': 'Договор подписан',
  'din.recorded': 'Записан фактический DIN',
  'price.overridden': 'Цена изменена вручную',
  'limit.overridden': 'Лимит снят вручную',
  'noshow.cleared': 'Снята отметка о неявке',
  'inventory.adjusted': 'Правка остатка',
  'privacy.subject_deleted': 'Данные клиента удалены по требованию',
}

export function eventLabel(kind: string): string {
  return EVENT_LABELS[kind] ?? kind
}

/** Кто совершил действие — для хронологии. */
export function actorLabel(actorType: string | null, actorName: string | null): string {
  if (actorName) return actorName
  if (actorType === 'customer') return 'Клиент'
  if (actorType === 'system') return 'Система'
  if (actorType === 'staff') return 'Сотрудник'
  return 'Неизвестно'
}
