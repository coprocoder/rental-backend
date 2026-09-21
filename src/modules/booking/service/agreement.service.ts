/**
 * Текст оферты для показа клиенту.
 *
 * ⚠️ Отдаётся вместе с версией и хешем: клиент подписывает именно ту
 * редакцию, которую увидел, и хеш это фиксирует. Показывать один
 * текст, а хешировать другой — значит не иметь доказательства вовсе.
 */
import type { Deps } from '~/kernel/deps'
import { apiError } from '~/kernel/errors'
import { offerFor } from '~/domain/orders/agreement'
import { activeText } from '~/domain/admin/texts'

/**
 * ⚠️ Оферта, политика ПД и правила аренды — три РАЗНЫХ документа
 * (ТЗ 00-общее/04-правовое). Форма обязана дать ссылку на каждый:
 * галка «принимаю условия» без возможности их прочитать согласием
 * не является.
 */
export const DOCUMENT_KINDS = ['offer', 'privacy', 'rules'] as const
export type DocumentKind = (typeof DOCUMENT_KINDS)[number]

export async function getDocument(
  input: { tenant: string, kind: DocumentKind },
  deps: Deps,
) {
  const tenants = await deps.db.unscoped<{ id: string }>(
    `SELECT id FROM tenant WHERE slug = $1 AND archived_at IS NULL`,
    [input.tenant],
  )
  const tenantId = tenants[0]?.id
  if (!tenantId) throw apiError('TENANT_NOT_FOUND', 'Прокат не найден')

  return deps.db.tx(tenantId, async (c) => {
    // ⚠️ Оферта — через offerFor, а не напрямую: у тенантов, заведённых
    // до версионирования, текст лежит в theme, и этот фолбэк терять нельзя.
    if (input.kind === 'offer') return await offerFor(c, tenantId)

    const t = await activeText(c, { tenantId, kind: input.kind })
    if (!t) throw apiError('NOT_FOUND', 'Документ не опубликован')
    return { version: `v${t.version}`, text: t.body, hash: t.hash }
  })
}
