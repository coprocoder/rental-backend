/**
 * Deps — всё, что usecase получает извне, вместо того чтобы импортировать.
 *
 * ⚠️ Это буква D из SOLID в единственном виде, который здесь реально
 * окупается. Без неё сценарный тест требует живых часов и реальной
 * отправки уведомлений; с ней — подменяемые часы и накопитель вместо
 * очереди, и тест про «бронь снимается через 20 минут» пишется за минуту,
 * а не «не пишется вовсе».
 *
 * ⚠️ Deps — не свалка сервисов. Сюда попадает только то, что делает I/O:
 * БД, часы, очередь, журнал. Бизнес-правила импортируются напрямую —
 * они чистые, подменять их в тесте незачем.
 */
import type { Db } from './db'
import type { Clock } from './clock'
import type { Notifier } from './outbox'
import type { Logger } from './logger'

export interface Deps {
  readonly db: Db
  readonly clock: Clock
  readonly notifier: Notifier
  readonly logger: Logger
}
