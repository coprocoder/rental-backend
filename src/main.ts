/**
 * Точка входа сервиса.
 *
 * ⚠️ Вся сборка зависимостей — здесь, и только здесь. Модули ничего не
 * создают при импорте: пул, часы и журнал приходят к ним параметрами.
 * Поэтому тест поднимает то же приложение с другими deps, не подменяя
 * модули через моки импортов.
 */
import { loadConfig } from './kernel/config'
import { createDb } from './kernel/db'
import { createLogger } from './kernel/logger'
import { systemClock } from './kernel/clock'
import { outboxNotifier } from './kernel/outbox'
import { createApp } from './transport/app'
import type { Deps } from './kernel/deps'

async function main(): Promise<void> {
  const config = loadConfig()
  const logger = createLogger(config)

  const db = createDb({ url: config.databaseUrl })
  const deps: Deps = { db, clock: systemClock, notifier: outboxNotifier, logger }

  const app = createApp({ config, deps })

  /**
   * Мягкое завершение.
   *
   * ⚠️ Без него выкатка по одной реплике теряет запросы: процесс умирает
   * посреди транзакции, клиент получает обрыв соединения. Fastify.close()
   * перестаёт принимать новые запросы и дожидается текущих.
   *
   * ⚠️ Таймаут обязателен: запрос, зависший на блокировке в БД, иначе
   * держит процесс вечно, и оркестратор всё равно убьёт его — но позже
   * и грубее.
   */
  let shuttingDown = false
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ signal }, 'завершение: новые запросы не принимаются')

    const force = setTimeout(() => {
      logger.error('завершение затянулось, выходим принудительно')
      process.exit(1)
    }, 15_000)
    force.unref()

    try {
      await app.close()
      await db.close()
      logger.info('завершено штатно')
      process.exit(0)
    } catch (err) {
      logger.error({ err }, 'ошибка при завершении')
      process.exit(1)
    }
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  await app.listen({ port: config.port, host: config.host })
  logger.info({ port: config.port }, 'rental-api слушает')
}

main().catch((err) => {
  // ⚠️ console, а не logger: упасть мы могли именно на создании logger
  // или чтении конфигурации, и тогда logger не существует.
  console.error('не удалось запустить сервис:', err)
  process.exit(1)
})
