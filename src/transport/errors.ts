/**
 * Единственное место, где ошибка превращается в HTTP-ответ.
 *
 * ⚠️ Именно единственное. Пока обработчики сами решали, что отдать,
 * форма ответа расходилась между эндпоинтами, и виджет на чужом сайте
 * не мог полагаться на код. Здесь конверт один на весь API.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { App } from './types'
import { ApiError, apiError, isApiError } from '../kernel/errors'

export function registerErrorHandler(app: App): void {
  app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
    const err = apiError('NOT_FOUND', 'Маршрут не найден')
    reply.status(err.statusCode).send(err.toBody())
  })

  app.setErrorHandler((err: Error, req: FastifyRequest, reply: FastifyReply) => {
    if (isApiError(err)) {
      // ⚠️ Ожидаемые ответы предметной области НЕ логируются как ошибки:
      // «позицию только что забрали» — самый частый ответ в воронке
      // бронирования, и на уровне error он утопит настоящие сбои.
      req.log.info({ code: err.code, statusCode: err.statusCode }, 'api error')
      reply.status(err.statusCode).send(err.toBody())
      return
    }

    // ⚠️ Тело непредвиденной ошибки наружу не уходит: текст исключения
    // способен содержать фрагмент SQL и имена колонок. В журнале — всё,
    // клиенту — код и correlation_id, по которому поддержка найдёт запись.
    req.log.error({ err }, 'unhandled error')
    const wrapped = new ApiError('INTERNAL', 'Внутренняя ошибка')
    reply.status(wrapped.statusCode).send({
      error: { ...wrapped.toBody().error, details: { correlationId: req.id } },
    })
  })
}
