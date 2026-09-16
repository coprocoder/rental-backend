/**
 * Маршруты входа и сессии сотрудника.
 *
 * ⚠️ Токен сессии читается и ставится ЗДЕСЬ и только здесь: транспорт —
 * единственный слой, который знает, что сессия ездит в cookie. Домен и
 * сценарии получают её уже разобранной.
 */
import * as v from 'valibot'
import type { App } from '~/transport/types'
import type { Deps } from '~/kernel/deps'
import { parse } from '~/transport/validate'
import { apiError } from '~/kernel/errors'
import { requireSession, SESSION_COOKIE } from '~/kernel/session'
import { login, logout, switchByPin } from '~/domain/core/auth'
import { getMe } from '../service/me.service'

/**
 * Нужна ли cookie сессии cross-site.
 *
 * ⚠️ Разные ПОРТЫ одного хоста — это НЕ cross-site: порт не входит в
 * понятие site (RFC 6265bis). Фронт на :3000 и API на :3200 для cookie
 * остаются одним сайтом, и `SameSite=Lax` работает. Поэтому локальная
 * разработка не требует ни `None`, ни TLS.
 *
 * Cross-site начинается с РАЗНЫХ ДОМЕНОВ — `app.example.com` и
 * `api.other.com`. Там нужен `SameSite=None`, а он по стандарту
 * обязывает `Secure`, то есть HTTPS. Включается явно переменной:
 * угадывать по CORS_ORIGINS нельзя — он задан и при одном домене.
 */
const CROSS_SITE_COOKIE = process.env.CROSS_SITE_COOKIE === '1'

const LoginBody = v.object({
  email: v.pipe(v.string(), v.email()),
  password: v.pipe(v.string(), v.minLength(8), v.maxLength(200)),
})

const SwitchBody = v.object({
  pin: v.pipe(v.string(), v.minLength(4), v.maxLength(12)),
})

export function registerAccessRoutes(app: App, deps: Deps): void {
  app.get('/v1/staff/me', async (req) => {
    const session = await requireSession(req.cookies[SESSION_COOKIE])
    return getMe(session, deps)
  })

  /**
   * ⚠️ Один и тот же ответ на «нет такого email» и «неверный пароль»:
   * иначе перебором выясняется список сотрудников проката.
   *
   * ⚠️ Токен сессии — в HttpOnly cookie, а не в теле ответа: иначе он
   * доступен любому скрипту на странице, включая внедрённый.
   */
  app.post('/v1/staff/login', async (req, reply) => {
    let parsed
    try {
      parsed = parse(LoginBody, req.body)
    } catch {
      throw apiError('VALIDATION_FAILED', 'Проверьте email и пароль')
    }

    const result = await login({
      email: parsed.email,
      password: parsed.password,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    })

    if (!result.ok) {
      if (result.reason === 'locked') {
        throw apiError('FORBIDDEN', 'Аккаунт заблокирован — обратитесь к владельцу')
      }
      if (result.reason === 'too_many_attempts') {
        throw apiError('RATE_LIMITED', 'Слишком много попыток входа, подождите')
      }
      throw apiError('FORBIDDEN', 'Неверный email или пароль')
    }

    // ⚠️ Secure по умолчанию в проде — без него сессионная кука уйдёт по
    // открытому HTTP и её увидит любой посредник.
    //
    // ⚠️ Ровно поэтому демо-стенд БЕЗ TLS не работал: сервер ставил куку
    // с Secure, браузер её по http:// не сохранял, login отвечал 200,
    // а следующий же staff/me — 403. Симптом «вход не удался» при верном
    // пароле и рабочем API. ALLOW_INSECURE_COOKIE=1 снимает флаг ОСОЗНАННО
    // и только для показа демки по http.
    const insecureAllowed = process.env.ALLOW_INSECURE_COOKIE === '1'

    // ⚠️ SameSite зависит от того, на одном ли origin живут фронт и API.
    // После выноса бэкенда они РАЗНЫЕ, и при 'lax' браузер не отправит
    // cookie обратно: вход отвечает 200, а следующий же staff/me — 403.
    // Симптом «вход не удался» при верном пароле и рабочем API.
    //
    // ⚠️ 'none' требует Secure по стандарту, поэтому по HTTP он
    // применим только вместе с ALLOW_INSECURE_COOKIE — то есть на
    // локальной машине и демо-стенде, где TLS нет.
    const crossSite = CROSS_SITE_COOKIE
    const secure = crossSite
      ? !insecureAllowed
      : process.env.NODE_ENV === 'production' && !insecureAllowed

    reply.setCookie(SESSION_COOKIE, result.token, {
      httpOnly: true,
      sameSite: crossSite ? 'none' : 'lax',
      secure,
      path: '/',
      maxAge: 16 * 3600,
    })

    return {
      staff: {
        name: result.session.activeName,
        role: result.session.activeRole,
        branchIds: result.session.branchIds,
      },
    }
  })

  /** Выход: сессия отзывается в БД, а не только удаляется cookie. */
  app.post('/v1/staff/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE]
    if (token) await logout(token)
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return { ok: true }
  })

  /** Переключение активного сотрудника по PIN в пределах одной сессии. */
  app.post('/v1/staff/switch', async (req) => {
    const token = req.cookies[SESSION_COOKIE]
    if (!token) throw apiError('FORBIDDEN', 'Нужен вход')

    let parsed
    try {
      parsed = parse(SwitchBody, req.body)
    } catch {
      throw apiError('VALIDATION_FAILED', 'Неверный формат PIN')
    }

    const session = await switchByPin(token, parsed.pin)
    if (!session) throw apiError('FORBIDDEN', 'PIN не распознан')

    return {
      name: session.activeName,
      role: session.activeRole,
      branchIds: session.branchIds,
    }
  })
}
