/**
 * Тарифы: что включено и что закрыто.
 *
 * ⚠️ Эти тесты существуют потому, что механизм уже один раз оказался
 * написанным и НЕ ПОДКЛЮЧЁННЫМ: `hasFeature` был в коде с самого
 * начала и не вызывался ни одним обработчиком, то есть все флаги
 * тарифа не ограничивали ничего. Здесь закрепляется не поведение
 * функции, а сам факт, что отказ происходит.
 */
import { describe, expect, it } from 'vitest'
import {
  entitlementsFor,
  hasFeature,
  requireFeature,
} from '~/domain/core/entitlements'
import { PLAN_FEATURES } from '~/common/contract/plans'
import { inRollback } from '../../../db/test/setup'

/** Старший тариф: включает ВСЁ — по нему и проверяется полнота. */
const PRO = {
  maxBranches: null, maxVariants: null,
  labeledInventory: true, multiBranch: true, advancedInventory: true,
  analytics: true, branding: true, delegatedRoles: true,
  customDomain: true, removeBranding: true, apiAccess: true, smsChannel: true,
}

async function tenantOnPlan(
  c: import('pg').PoolClient,
  code: string,
  limits: Record<string, unknown>,
) {
  const { rows: [p] } = await c.query<{ id: string }>(
    `INSERT INTO plan (code, name, price_per_month, limits)
     VALUES ($1, $1, 1000, $2::jsonb) RETURNING id`,
    [`${code}-${Math.random().toString(36).slice(2, 8)}`, JSON.stringify(limits)],
  )
  const { rows: [t] } = await c.query<{ id: string }>(
    `INSERT INTO tenant (slug, name, plan_id, paid_until)
     VALUES ('t-' || gen_random_uuid(), 'Тест', $1, now() + interval '1 year')
     RETURNING id`,
    [p!.id],
  )
  return t!.id
}

describe('функции тарифа', () => {
  it('базовый тариф не даёт платных функций', async () => {
    await inRollback(async (c) => {
      const id = await tenantOnPlan(c, 'start', { maxBranches: 1, maxVariants: 200 })
      const e = await entitlementsFor(c, id)

      for (const f of PLAN_FEATURES) {
        expect(hasFeature(e, f), `${f} не должна быть включена`).toBe(false)
      }
    })
  })

  it('старший тариф даёт все функции', async () => {
    await inRollback(async (c) => {
      const id = await tenantOnPlan(c, 'pro', PRO)
      const e = await entitlementsFor(c, id)

      for (const f of PLAN_FEATURES) {
        expect(hasFeature(e, f), `${f} должна быть включена`).toBe(true)
      }
    })
  })

  /**
   * ⚠️ Главный тест: пустой `limits` — это БАЗОВЫЙ тариф, а не
   * «ограничений нет». Обратное трактование раздало бы платные
   * функции каждому тенанту, у которого лимиты просто не заполнили.
   */
  it('тариф без описанных лимитов закрыт, а не открыт', async () => {
    await inRollback(async (c) => {
      const id = await tenantOnPlan(c, 'empty', {})
      const e = await entitlementsFor(c, id)

      for (const f of PLAN_FEATURES) {
        expect(hasFeature(e, f), `${f} не должна открываться по умолчанию`).toBe(false)
      }
    })
  })

  it('requireFeature отказывает кодом PLAN_REQUIRED, а не FORBIDDEN', async () => {
    await inRollback(async (c) => {
      const id = await tenantOnPlan(c, 'start', {})

      // ⚠️ Отдельный код принципиален: «вам нельзя» и «включите тариф»
      // ведут человека в разные стороны.
      await expect(requireFeature(c, id, 'analytics')).rejects.toMatchObject({
        statusCode: 402,
        code: 'PLAN_REQUIRED',
      })
    })
  })

  it('requireFeature пропускает при включённой функции', async () => {
    await inRollback(async (c) => {
      const id = await tenantOnPlan(c, 'pro', PRO)
      await expect(requireFeature(c, id, 'analytics')).resolves.toBeUndefined()
    })
  })
})
