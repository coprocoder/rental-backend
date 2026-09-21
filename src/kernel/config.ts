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
  /**
   * Открыты ли демонстрационные страницы (`/tour`) и данные к ним.
   *
   * ⚠️ По умолчанию ЗАКРЫТО (fail closed). Обход выдаёт ЖИВЫЕ токены
   * заказа — то есть ссылки, по которым посторонний подтвердит или
   * отменит чужую бронь. Забытая переменная обязана давать «закрыто».
   *
   * ⚠️ Флаг РАНТАЙМА, а не сборки. Один образ едет и на демо-стенд,
   * и на хост заказчика; разница — переменная окружения. Раньше здесь
   * было два решения (страница смотрела на переменную, а данные к ней —
   * на флаг сборки), они разошлись, и тур открывался полупустым:
   * пропадали пункты про конкретный заказ. Симптом из причины
   * не следовал никак.
   */
  readonly allowDevPages: boolean
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
    // ⚠️ Вне продакшена открыто всегда: иначе локальный `make dev`
    // требовал бы переменной, о которой никто не помнит, и /tour
    // отдавал бы 404 на машине разработчика.
    allowDevPages: process.env.NODE_ENV !== 'production'
      || String(process.env.ALLOW_DEV_PAGES ?? '') === '1',
  }
}
