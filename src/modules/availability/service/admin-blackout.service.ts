/** Действующие отключения позиции (18.2). */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import * as v from 'valibot'
import { apiError } from '~/kernel/errors'
import { listBlackouts } from '~/domain/availability/blackout'

export async function getBlackout(
  session: Session,
  input: Record<string, unknown>,
  deps: Deps,
) {

  const variantId = input.variantId as string | undefined
  if (!variantId || !v.safeParse(v.pipe(v.string(), v.uuid()), variantId).success) {
    throw apiError('VALIDATION_FAILED', 'Не указана позиция', { field: 'variantId' })
  }

  return deps.db.tx(session.tenantId, async (c) => ({
    rows: await listBlackouts(c, { tenantId: session.tenantId, variantId }),
  }))
}
