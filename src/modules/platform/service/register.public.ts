/**
 * Регистрация тенанта — пробный период один сезон.
 *
 * ⚠️ «Один сезон бесплатно» (docs/TODO.md 14.1), а не «14 дней»: прокат
 * не успеет оценить систему за две недели межсезонья, а сезон — это
 * и есть единица его бизнеса. Шесть месяцев с момента регистрации.
 *
 * Создаётся сразу всё, без чего форма не заработает: тенант, тариф
 * «старт», лимиты по умолчанию, первый филиал, владелец и публичный
 * ключ для виджета. Ключ показывается ОДИН раз — в базе только хеш.
 *
 * ⚠️ Публичный эндпоинт без сессии — единственный, который создаёт
 * тенанта. Защита от массовой регистрации — rate limiting по IP
 * (7.8) и подтверждение почты владельца; второе в MVP заменено
 * пробным периодом: неподтверждённый тенант просто истечёт.
 */
import type { Deps } from '~/kernel/deps'
import * as v from 'valibot'
import { apiError, mapDbError } from '~/kernel/errors'
import { hashPassword } from '~/domain/core/auth'
import { issueApiKey } from '~/domain/platform/api-key'
import { createDemoInventory } from '~/domain/admin/demo'

export const RegisterBody = v.object({
  slug: v.pipe(v.string(), v.regex(/^[a-z0-9-]{3,40}$/)),
  name: v.pipe(v.string(), v.minLength(2), v.maxLength(120)),
  ownerName: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  ownerEmail: v.pipe(v.string(), v.email()),
  password: v.pipe(v.string(), v.minLength(8), v.maxLength(200)),
  branchName: v.optional(v.pipe(v.string(), v.maxLength(120))),
  /** IANA, например Asia/Krasnoyarsk. Пояс у ФИЛИАЛА, не у тенанта. */
  timezone: v.pipe(v.string(), v.minLength(3), v.maxLength(64)),
  /** Заполнить демо-каталогом, чтобы форма заработала сразу. */
  withDemo: v.optional(v.boolean()),
})

export interface PostRegisterInput {
  body: unknown
}

export async function postRegister(
  req: PostRegisterInput,
  deps: Deps,
) {
  const parsed = v.safeParse(RegisterBody, req.body)
  if (!parsed.success) throw apiError('VALIDATION_FAILED', 'Проверьте поля регистрации')
  const input = parsed.output

  // Пояс проверяется через Intl, а не по списку: список устаревает.
  try {
    new Intl.DateTimeFormat('en', { timeZone: input.timezone })
  } catch {
    throw apiError('VALIDATION_FAILED', 'Неизвестный часовой пояс')
  }

  try {
    // Тенанта ещё нет — контекста RLS быть не может. Создаём под ролью
    // воркера, дальше всё под своим tenant_id.
    const created = await deps.db.txAnonymous(async (c) => {
      // ⚠️ Заводим оба тарифа, а новый прокат сажаем на базовый:
      // список тарифов нужен, чтобы владелец видел, куда расти.
      const { rows: [plan] } = await c.query<{ id: string }>(
        `INSERT INTO plan (code, name, price_per_month, limits)
         VALUES ('start', 'Старт', 1500, '{"maxBranches": 1, "maxVariants": 200}')
         ON CONFLICT (code) DO UPDATE SET name = excluded.name
         RETURNING id`,
      )
      await c.query(
        `INSERT INTO plan (code, name, price_per_month, limits)
         VALUES ('pro', 'Расширенный', 3500, '{"maxBranches": null, "maxVariants": null, "multiBranch": true, "advancedInventory": true, "analytics": true, "branding": true, "delegatedRoles": true}')
         ON CONFLICT (code) DO UPDATE SET limits = excluded.limits`,
      )
      const { rows: [tenant] } = await c.query<{ id: string }>(
        `INSERT INTO tenant (slug, name, plan_id, paid_until, day_mode)
         VALUES ($1, $2, $3, now() + interval '6 months', 'calendar')
         RETURNING id`,
        [input.slug, input.name, plan!.id],
      )
      return tenant!.id
    })

    return await deps.db.tx(created, async (c) => {
      await c.query(`INSERT INTO booking_limit (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [created])

      const { rows: [branch] } = await c.query<{ id: string }>(
        `INSERT INTO branch (tenant_id, name, timezone) VALUES ($1, $2, $3) RETURNING id`,
        [created, input.branchName ?? 'Основной', input.timezone],
      )

      await c.query(
        `INSERT INTO staff (tenant_id, email, name, role, password_hash)
         VALUES ($1, $2, $3, 'owner', $4)`,
        [created, input.ownerEmail.toLowerCase(), input.ownerName, await hashPassword(input.password)],
      )

      const key = await issueApiKey(c, { tenantId: created, kind: 'public' })

      let demo: { variants: number } | null = null
      if (input.withDemo) {
        demo = await createDemoInventory(c, { tenantId: created, branchId: branch!.id })
      }

      await c.query(
        `INSERT INTO event (tenant_id, aggregate_type, aggregate_id, kind, payload, actor_type)
         VALUES ($1, 'tenant', $1, 'tenant.registered', $2, 'system')`,
        [created, JSON.stringify({ slug: input.slug, withDemo: !!input.withDemo })],
      )

      return {
        tenantId: created,
        slug: input.slug,
        bookingUrl: `/r/${input.slug}`,
        /** ⚠️ Показывается один раз: в базе только хеш. */
        publicKey: key.key,
        trialUntil: new Date(Date.now() + 182 * 86_400_000).toISOString().slice(0, 10),
        demo,
      }
    })
  } catch (err) {
    // Уникальность slug — 23505.
    if ((err as { code?: string }).code === '23505') {
      throw apiError('VALIDATION_FAILED', 'Такой адрес уже занят, выберите другой slug')
    }
    throw mapDbError(err)
  }
}
