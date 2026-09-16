/** Тексты тенанта со всей историей редакций (13.14). */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import { listVersions, TEXT_KINDS, type TextKind } from '~/domain/admin/texts'
import { offerFor } from '~/domain/orders/agreement'

export async function getTexts(
  session: Session,
  input: Record<string, unknown>,
  deps: Deps,
) {
  const kind = String(input.kind ?? '') as TextKind

  return deps.db.tx(session.tenantId, async (c) => {
    const versions = await listVersions(c, {
      tenantId: session.tenantId,
      kind: TEXT_KINDS.some((k) => k.kind === kind) ? kind : undefined,
    })

    // ⚠️ Заготовка платформы отдаётся отдельно: пока тенант не завёл
    // свою оферту, действует именно она, и владелец должен видеть,
    // что подписывают его клиенты прямо сейчас.
    const fallbackOffer = versions.some((v) => v.kind === 'offer' && v.isActive)
      ? null
      : await offerFor(c, session.tenantId)

    return { kinds: TEXT_KINDS, versions, fallbackOffer }
  })
}
