/**
 * Тип приложения — один на весь сервис.
 *
 * ⚠️ Нужен потому, что Fastify параметризует FastifyInstance типом
 * журнала. Передав конкретный pino.Logger в конструктор, мы получаем
 * инстанс, НЕ совместимый с обычным `FastifyInstance`, и каждая функция,
 * принимающая приложение, начинает спорить о generic-параметрах.
 *
 * Альтернативы были хуже: `any` убирает проверку там, где регистрируются
 * все маршруты, а отказ от своего logger в пользу дефолтного означает
 * потерю redact — то есть токены и ключи в журнале.
 */
import type { FastifyInstance } from 'fastify'
import type { Logger } from '../kernel/logger'

export type App = FastifyInstance<
  import('node:http').Server,
  import('node:http').IncomingMessage,
  import('node:http').ServerResponse,
  Logger
>
