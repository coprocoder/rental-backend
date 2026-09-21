/**
 * Сохранение темы тенанта (13.15).
 *
 * ⚠️ Через тот же белый список, что и чтение (shared/theme.ts). Пока
 * список был написан дважды, можно было сохранить поле, которое витрина
 * молча игнорирует: прокат меняет цвет, ничего не происходит, и он
 * идёт в поддержку.
 *
 * ⚠️ Контраст ПРОВЕРЯЕТСЯ, но не запрещает сохранение. Прокат вправе
 * выбрать свой фирменный цвет, даже неудачный, — система обязана
 * предупредить и показать, как это выглядит. Запрет означал бы, что
 * владелец не может поставить логотипный цвет, и это довод уйти
 * к конкуренту, а не аргумент за доступность.
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import * as v from 'valibot'
import { apiError, mapDbError } from '~/kernel/errors'
import { audit } from '~/domain/core/order-lifecycle'
import { pickTheme, ALLOWED_RADII } from '~/common/utils/theme'
import { verdictOn } from '~/common/utils/contrast'

const Hex = v.pipe(v.string(), v.regex(/^#[0-9a-f]{6}$/i, 'Цвет — six-значный HEX вида #0b6b5e'))

export const ThemeBody = v.object({
  brand: v.optional(Hex),
  brandSubtle: v.optional(Hex),
  bg: v.optional(Hex),
  surface: v.optional(Hex),
  radius: v.optional(v.picklist(ALLOWED_RADII.map(String))),
  logoUrl: v.optional(v.pipe(v.string(), v.maxLength(300))),
})

export interface PostThemeRequest {
  body: unknown
}

export async function postTheme(
  session: Session,
  req: PostThemeRequest,
  deps: Deps,
) {

  const parsed = v.safeParse(ThemeBody, req.body)
  if (!parsed.success) {
    throw apiError('VALIDATION_FAILED', parsed.issues[0]?.message ?? 'Проверьте цвета')
  }

  const theme = pickTheme({
    ...parsed.output,
    radius: parsed.output.radius ? Number(parsed.output.radius) : undefined,
  })

  try {
    return await deps.db.tx(session.tenantId, async (c) => {
      const { rows: before } = await c.query<{ theme: Record<string, unknown> | null }>(
        `SELECT theme FROM tenant WHERE id = $1`,
        [session.tenantId],
      )

      await c.query(`UPDATE tenant SET theme = $2 WHERE id = $1`, [session.tenantId, theme])

      // ⚠️ Смена темы — в журнал: витрина меняется у всех клиентов
      // проката разом, и «кто это сделал» — вопрос, который задают.
      await audit(c, {
        tenantId: session.tenantId,
        staffId: session.staffId,
        action: 'theme.updated',
        targetType: 'tenant',
        targetId: session.tenantId,
        reason: 'изменение темы витрины',
        before: before[0]?.theme ?? {},
        after: theme,
      })

      return {
        theme,
        // Вердикт возвращается вместе с сохранённым — чтобы предупреждение
        // осталось на экране и после сохранения, а не исчезло с формой.
        contrast: theme.brand ? verdictOn(theme.brand) : null,
      }
    })
  } catch (err) {
    throw mapDbError(err)
  }
}
