/**
 * Конфигурация из окружения, прочитанная ОДИН раз при старте.
 *
 * ⚠️ Читать `process.env` посреди работы нельзя: тогда нет ни одного
 * места, где видно, что сервису нужно для запуска, и отсутствие
 * переменной обнаруживается на первом запросе, а не при старте.
 * Здесь же процесс либо поднялся, либо честно упал с понятным текстом.
 *
 * ⚠️ Адрес БД не зашит нигде в коде — это условие для выделенной базы
 * крупному заказчику (`plans/04-ДАННЫЕ.md`, ступень 5).
 */
export interface Config {
  readonly port: number
  readonly host: string
  readonly databaseUrl: string
  readonly workerDatabaseUrl: string
  readonly logLevel: string
  readonly serviceName: string
  readonly isProduction: boolean
  /**
   * Origins, которым разрешён доступ к публичному API.
   *
   * ⚠️ Появляется только при выносе бэка: пока код жил внутри Nuxt,
   * фронт и API были одним origin и CORS не существовало как вопроса.
   * Пустой список означает «тот же origin», а не «всем можно».
   */
  readonly corsOrigins: readonly string[]
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} не задан`)
  return value
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (Number.isNaN(parsed)) throw new Error(`${name} должен быть числом, получено: ${raw}`)
  return parsed
}

export function loadConfig(): Config {
  const databaseUrl = required('DATABASE_URL')
  return {
    port: optionalInt('PORT', 3200),
    // ⚠️ 0.0.0.0, а не localhost: в контейнере привязка к localhost
    // делает сервис недоступным снаружи, и это выглядит как «не
    // запустился», хотя процесс жив.
    host: process.env.HOST ?? '0.0.0.0',
    databaseUrl,
    // Локально роль воркера может совпадать с основной; в проде она
    // обязана быть отдельной — с BYPASSRLS.
    workerDatabaseUrl: process.env.DATABASE_URL_WORKER ?? databaseUrl,
    logLevel: process.env.LOG_LEVEL ?? 'info',
    serviceName: process.env.SERVICE_NAME ?? 'rental-api',
    isProduction: process.env.NODE_ENV === 'production',
    corsOrigins: (process.env.CORS_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  }
}
