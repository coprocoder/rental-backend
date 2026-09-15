/**
 * Структурные логи (16.5).
 *
 * ⚠️ pino, а не console.log: воркер и приложение пишут JSON, и по
 * correlation_id одна цепочка — запрос, событие, отправка — собирается
 * одним grep. Текстовые логи с разным форматом в двух процессах этого
 * не дают.
 *
 * ⚠️ Токены заказов и ключи API в лог не попадают: redact вырезает
 * поля с ними, иначе доступ к ПД клиентов осядет в файлах логов
 * (../rental-docs/docs/04-тз/10-бэкенд/17-доступ-и-роли.md).
 */
import pino, { type Logger } from 'pino'

export type { Logger }

export function createLogger(opts: {
  logLevel: string
  serviceName: string
  isProduction: boolean
}): Logger {
  return pino({
    level: opts.logLevel,
    redact: {
      paths: ['token', '*.token', 'tokens', '*.tokens', 'key', '*.key', 'password', '*.password',
        'req.headers.cookie', 'req.headers.authorization'],
      censor: '[скрыто]',
    },
    base: { service: opts.serviceName },
    // В разработке — читаемо; в проде — JSON для сборщика.
    ...(opts.isProduction
      ? {}
      : { transport: { target: 'pino/file', options: { destination: 1 } } }),
  })
}
