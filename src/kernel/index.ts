/**
 * Фасад kernel — то, что импортируют модули.
 *
 * ⚠️ kernel — НЕ свалка. Критерий попадания сюда: без этого не работает
 * ни один модуль. Нужно двум модулям из девяти — это не kernel, а модуль,
 * от которого они оба зависят явно (`plans/01-МОДУЛИ.md`).
 */
export { type Ctx, type Actor } from './context'
export { type Deps } from './deps'
export { type Db, type PoolClient, createDb, createWorkerDb } from './db'
export { type Clock, systemClock, fixedClock } from './clock'
export { type Notifier, outboxNotifier } from './outbox'
export { type Logger, createLogger } from './logger'
export { type Config, loadConfig } from './config'
export {
  ApiError, type ApiErrorCode, apiError, isApiError, mapDbError,
} from './errors'
