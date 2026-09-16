/**
 * Контракт транспорта: конверт ошибки, health check, CORS.
 *
 * ⚠️ Через `app.inject()`, без сети и без базы: deps подменяются
 * целиком. Это и есть выгода от инверсии зависимостей — проверить,
 * что упавшая база выключает реплику из балансировки, иначе можно
 * было бы только выключив настоящую базу.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Config } from '../../kernel/config'
import type { Deps } from '../../kernel/deps'
import { fixedClock } from '../../kernel/clock'
import { createApp } from '../app'

const config: Config = {
  port: 0,
  host: '127.0.0.1',
  databaseUrl: 'postgres://unused',
  workerDatabaseUrl: 'postgres://unused',
  logLevel: 'silent',
  serviceName: 'test',
  isProduction: false,
  corsOrigins: ['https://shop.example'],
}

const silentLogger = {
  info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(),
  fatal: vi.fn(), trace: vi.fn(), silent: vi.fn(), level: 'silent',
  child() { return this },
} as unknown as Deps['logger']

function makeDeps(over: Partial<Deps> = {}): Deps {
  return {
    db: {
      tx: vi.fn(), txAnonymous: vi.fn(),
      unscoped: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
      close: vi.fn(),
    },
    clock: fixedClock('2026-01-15T10:00:00Z'),
    notifier: { publish: vi.fn() },
    logger: silentLogger,
    ...over,
  }
}

describe('health', () => {
  it('отвечает ok, когда база доступна', async () => {
    const res = await createApp({ config, deps: makeDeps() }).inject({ url: '/health' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })

  /**
   * ⚠️ Смысл проверки именно в этом: экземпляр, потерявший базу, обязан
   * выпасть из балансировки. Маршрут, который всегда отвечает «жив»,
   * оставляет в ротации реплику, отдающую ошибки на каждый запрос —
   * и балансировщик исправно шлёт туда трафик.
   */
  it('отвечает 503, когда база недоступна', async () => {
    const deps = makeDeps()
    ;(deps.db.unscoped as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ECONNREFUSED'))

    const res = await createApp({ config, deps }).inject({ url: '/health' })

    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ status: 'degraded' })
  })
})

describe('конверт ошибки', () => {
  it('неизвестный маршрут — тот же конверт, а не HTML фреймворка', async () => {
    const res = await createApp({ config, deps: makeDeps() }).inject({ url: '/v1/nope' })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Маршрут не найден' } })
  })

  /**
   * ⚠️ Текст непредвиденной ошибки наружу НЕ уходит: исключение способно
   * содержать фрагмент SQL и имена колонок. В Nuxt-версии наружу уезжал
   * ещё и стек с абсолютными путями файлов сервера.
   */
  it('непредвиденная ошибка не выносит наружу подробности', async () => {
    const app = createApp({ config, deps: makeDeps() })
    app.get('/boom', async () => { throw new Error('SELECT secret FROM staff') })

    const res = await app.inject({ url: '/boom' })
    const body = res.json()

    expect(res.statusCode).toBe(500)
    expect(body.error.code).toBe('INTERNAL')
    expect(JSON.stringify(body)).not.toContain('SELECT')
    // Взамен — correlation_id, по которому поддержка найдёт запись в журнале.
    expect(body.error.details.correlationId).toBeTruthy()
  })
})

describe('correlation_id', () => {
  it('сквозной: приходит от вызывающего и возвращается тем же', async () => {
    const res = await createApp({ config, deps: makeDeps() }).inject({
      url: '/health',
      headers: { 'x-correlation-id': 'test-corr-1' },
    })

    expect(res.headers['x-correlation-id']).toBe('test-corr-1')
  })

  it('без заголовка — свой, а не пустой', async () => {
    const res = await createApp({ config, deps: makeDeps() }).inject({ url: '/health' })

    expect(res.headers['x-correlation-id']).toBeTruthy()
  })
})

describe('CORS', () => {
  /**
   * ⚠️ Появляется только при выносе бэка: пока код жил внутри Nuxt,
   * фронт и API были одним origin, и CORS не существовало как вопроса.
   */
  it('разрешённый origin получает заголовки и credentials', async () => {
    const res = await createApp({ config, deps: makeDeps() }).inject({
      url: '/health', headers: { origin: 'https://shop.example' },
    })

    expect(res.headers['access-control-allow-origin']).toBe('https://shop.example')
    // Сессия сотрудника ездит в cookie — без credentials админка не работает.
    expect(res.headers['access-control-allow-credentials']).toBe('true')
  })

  /**
   * ⚠️ Пустой список origin означает «тот же origin», а НЕ «всем можно».
   * Ошибка в эту сторону открывает публичный API любому сайту.
   */
  it('чужой origin заголовков не получает', async () => {
    const res = await createApp({ config, deps: makeDeps() }).inject({
      url: '/health', headers: { origin: 'https://evil.example' },
    })

    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })
})

describe('префикс /api', () => {
  /**
   * ⚠️ Псевдоним существует ради переключения фронта одной переменной
   * окружения: в браузере 84 вызова написаны как `/api/v1/…`. Проверка
   * держит именно это свойство — иначе переключение потребует правки
   * 39 файлов, а откат станет невозможен той же переменной.
   */
  it('оба префикса ведут в один набор обработчиков', async () => {
    const app = createApp({ config, deps: makeDeps() })

    const bare = await app.inject({ url: '/v1/public/catalog' })
    const prefixed = await app.inject({ url: '/api/v1/public/catalog' })

    // Оба дошли до обработчика: это ошибка валидации, а не «маршрут не найден».
    expect(bare.statusCode).toBe(422)
    expect(prefixed.statusCode).toBe(422)
    expect(prefixed.json()).toEqual(bare.json())
  })

  it('несуществующий маршрут под префиксом — тот же конверт', async () => {
    const res = await createApp({ config, deps: makeDeps() })
      .inject({ url: '/api/v1/nope' })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Маршрут не найден' } })
  })
})
