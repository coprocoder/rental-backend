/**
 * Сборка HTTP-приложения.
 *
 * ⚠️ Фабрика, а не модуль с побочными эффектами при импорте. Тест
 * поднимает своё приложение со своими deps; синглтон на уровне модуля
 * сделал бы это невозможным и заставил бы тесты делить состояние.
 */
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import type { Deps } from '../kernel/deps'
import type { Config } from '../kernel/config'
import type { App } from './types'
import { registerErrorHandler } from './errors'
import { buildOpenApi } from './openapi/build'
import { registerModules } from '../modules/registry'

export interface AppOptions {
  config: Config
  deps: Deps
}

export function createApp({ config, deps }: AppOptions): App {
  const app = Fastify({
    loggerInstance: deps.logger,
    // ⚠️ Свой correlation_id, если он пришёл от вызывающего: цепочка
    // «фронт → API → воркер → отправка» собирается одним grep только
    // когда идентификатор сквозной, а не рождается заново на каждом шаге.
    genReqId: (req) => {
      const header = req.headers['x-correlation-id']
      return typeof header === 'string' && header ? header : crypto.randomUUID()
    },
    // ⚠️ Доверять заголовкам прокси можно только за своим балансировщиком.
    // Без этого req.ip — адрес Caddy, и ограничение частоты по IP
    // ограничивает балансировщик, а не клиента.
    trustProxy: config.isProduction,
    // Тело запроса: каталог и состав заказа бывают крупными, но не такими.
    bodyLimit: 1_048_576,
  })

  app.register(cookie)

  // ⚠️ CORS появляется только при выносе бэка: пока код жил внутри Nuxt,
  // фронт и API были одним origin. Разрешаем ровно перечисленные origin
  // и credentials — сессия сотрудника ездит в cookie.
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin
    if (origin && config.corsOrigins.includes(origin)) {
      reply.header('access-control-allow-origin', origin)
      reply.header('access-control-allow-credentials', 'true')
      reply.header('vary', 'Origin')
    }
    if (req.method === 'OPTIONS') {
      reply.header('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS')
      reply.header('access-control-allow-headers', 'content-type,idempotency-key,x-widget-version,x-correlation-id')
      reply.header('access-control-max-age', '86400')
      reply.status(204).send()
    }
  })

  // Возвращаем correlation_id клиенту: без него поддержка не может
  // связать жалобу «не работает» с записью в журнале.
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-correlation-id', req.id)
  })

  registerErrorHandler(app)

  /**
   * Все маршруты модулей висят под `/api`.
   *
   * ⚠️ Версия `v1` — не здесь, а в каждом контроллере: они объявлены
   * как `/v1/admin/…`, `/v1/public/…`. Полный путь получается
   * `/api/v1/…` — именно его зовут 84 вызова на фронте.
   *
   * ⚠️ Так что второго префикса-псевдонима НЕТ: `/api/admin/branches`
   * отвечает 404, работает только `/api/v1/admin/branches`. Раньше
   * здесь стоял комментарий про «тот же API дополнительно на `/api`»
   * и совет убрать его вместе с `server/` из Nuxt — описание
   * устройства, которого в коде не было, и указание на каталог,
   * удалённый при выносе бэкенда.
   *
   * Переезд версии на этот уровень (`prefix: '/api/v1'`, контроллеры
   * без `/v1`) осмыслен только вместе с v2 — пока это 78 правок,
   * ничего не меняющих снаружи.
   */
  app.register(async (scoped) => {
    registerModules(scoped as unknown as App, deps)
  }, { prefix: '/api' })

  /**
   * Спецификация API.
   *
   * ⚠️ Отдаётся приложением, а не лежит файлом: файл расходится с кодом
   * молча, а этот документ собирается из тех же схем, которыми роуты
   * описаны, и сверяется с эталоном ответов тестом (19.42).
   *
   * ⚠️ Открыт без сессии намеренно: публичный контур нужен внешним
   * разработчикам виджета, а перечень рабочих маршрутов секретом
   * не является — доступ к ним закрывает сессия, а не незнание адреса.
   */
  app.get('/openapi.json', async (_req, reply) => {
    reply.header('cache-control', 'no-store')
    return buildOpenApi()
  })

  /**
   * Health check — проверяет СОЕДИНЕНИЕ С БД, а не отвечает 200
   * безусловно.
   *
   * ⚠️ Смысл именно в этом: экземпляр, потерявший базу, обязан выпасть
   * из балансировки. Маршрут, который всегда отвечает «жив», оставляет
   * в ротации реплику, отдающую ошибки на каждый запрос.
   */
  app.get('/health', async (req, reply) => {
    try {
      await deps.db.unscoped('SELECT 1')
      return { status: 'ok' }
    } catch (err) {
      req.log.error({ err }, 'health: база недоступна')
      reply.status(503)
      return { status: 'degraded' }
    }
  })

  registerModules(app, deps)

  return app
}
