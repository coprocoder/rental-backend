/**
 * Публичные маршруты платформы: регистрация проката и вебхуки
 * мессенджеров.
 *
 * ⚠️ Вебхуки анонимны по определению — их вызывает чужая система.
 * Подлинность проверяется секретом в заголовке внутри сервиса, а не
 * сессией: сессии здесь неоткуда взяться.
 */
import type { App } from '~/transport/types'
import type { Deps } from '~/kernel/deps'
import { postRegister } from '../service/register.public'
import { postTelegram } from '../service/telegram-webhook.public'
import { postMax } from '../service/max-webhook.public'
import { getTour } from '../service/tour.public'

export function registerPlatformPublic(app: App, deps: Deps): void {
  // ⚠️ Данные демонстрационного обхода. Закрыт ALLOW_DEV_PAGES,
  // на хосте заказчика отвечает 404.
  app.get('/v1/dev/tour', async () => getTour(deps))

  app.post('/v1/platform/register', async (httpReq) =>
    postRegister({ body: httpReq.body }, deps))

  app.post<{ Params: { slug: string } }>('/v1/public/telegram/:slug', async (httpReq) =>
    postTelegram({
      body: httpReq.body,
      params: httpReq.params as Record<string, string>,
      headers: httpReq.headers as Record<string, string | undefined>,
    }, deps))

  app.post<{ Params: { slug: string } }>('/v1/public/max/:slug', async (httpReq) =>
    postMax({
      body: httpReq.body,
      params: httpReq.params as Record<string, string>,
      headers: httpReq.headers as Record<string, string | undefined>,
    }, deps))
}
