/**
 * Токены доступа клиента к заказу.
 *
 * ⚠️ Это граница безопасности без пароля: у клиента проката нет и не
 * должно быть учётной записи, и весь доступ держится на токене
 * из ссылки. Модуль оставался без тестов, при том что ошибка здесь —
 * это чужая бронь в чужих руках.
 *
 * Проверяется ровно то, ради чего он написан:
 *   токен непредсказуем и НЕ производен от id заказа;
 *   в базе лежит только хеш — утечка дампа не даёт рабочих ссылок;
 *   токен «посмотреть» не позволяет отменить;
 *   истёкший и чужой токен неотличимы в ответе.
 */
import { describe, expect, it } from 'vitest'
import {
  hashToken,
  issueOrderTokens,
  locateByToken,
  markTokenUsed,
  resolveToken,
} from '~/domain/orders/order-token'
import { inRollback } from '../../../db/test/setup'

const DAY = 86_400_000

async function fixture(c: import('pg').PoolClient) {
  const { rows: [t] } = await c.query(
    `INSERT INTO tenant (slug, name) VALUES ('t-' || gen_random_uuid(), 'Тест')
     RETURNING id`,
  )
  const { rows: [b] } = await c.query(
    `INSERT INTO branch (tenant_id, name) VALUES ($1, 'Филиал') RETURNING id`,
    [t.id],
  )
  const from = new Date(Date.now() + 2 * DAY)
  const { rows: [o] } = await c.query(
    `INSERT INTO rental_order
       (tenant_id, branch_pickup_id, status, period, total_amount, public_code)
     VALUES ($1, $2, 'awaiting_confirm', tstzrange($3, $4, '[)'), 0, $5)
     RETURNING id`,
    [t.id, b.id, from, new Date(from.getTime() + DAY), `R${Math.floor(Math.random() * 1e6)}`],
  )
  return {
    tenantId: t.id as string,
    orderId: o.id as string,
    rentalEnd: new Date(from.getTime() + DAY),
  }
}

describe('выдача токенов', () => {
  it('на каждую цель свой токен, и все они разные', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const tokens = await issueOrderTokens(c, {
        tenantId: f.tenantId, orderId: f.orderId, rentalEnd: f.rentalEnd,
      })

      const values = [tokens.view, tokens.confirm, tokens.cancel]
      expect(new Set(values).size, 'три разных токена').toBe(3)
      // 32 байта в base64url — 256 бит энтропии.
      for (const v of values) expect(v.length).toBeGreaterThanOrEqual(42)
    })
  })

  it('⚠️ токен не производен от id заказа', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const tokens = await issueOrderTokens(c, {
        tenantId: f.tenantId, orderId: f.orderId, rentalEnd: f.rentalEnd,
      })

      // Иначе, зная один заказ, можно вычислить ссылки на все остальные.
      const bare = f.orderId.replace(/-/g, '')
      for (const v of Object.values(tokens)) {
        expect(v).not.toContain(f.orderId)
        expect(v.toLowerCase()).not.toContain(bare)
      }
    })
  })

  it('⚠️ в базе лежит ХЕШ, а не сам токен', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const tokens = await issueOrderTokens(c, {
        tenantId: f.tenantId, orderId: f.orderId, rentalEnd: f.rentalEnd,
      })

      const { rows } = await c.query<{ token_hash: string }>(
        `SELECT token_hash FROM order_token WHERE order_id = $1`, [f.orderId],
      )
      const hashes = rows.map((r) => r.token_hash)
      // Утечка дампа не должна давать рабочих ссылок.
      expect(hashes).not.toContain(tokens.view)
      expect(hashes).toContain(hashToken(tokens.view))
    })
  })

  it('срок жизни переживает конец аренды, но не бесконечен', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      await issueOrderTokens(c, {
        tenantId: f.tenantId, orderId: f.orderId, rentalEnd: f.rentalEnd,
      })

      const { rows } = await c.query<{ expires_at: Date }>(
        `SELECT expires_at FROM order_token WHERE order_id = $1 LIMIT 1`, [f.orderId],
      )
      // Клиенту нужно открыть заказ и после возврата — но не через год.
      expect(rows[0]!.expires_at.getTime()).toBeGreaterThan(f.rentalEnd.getTime())
      expect(rows[0]!.expires_at.getTime())
        .toBeLessThan(f.rentalEnd.getTime() + 60 * DAY)
    })
  })
})

describe('разбор токена', () => {
  it('⚠️ токен «посмотреть» не годится для отмены', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const tokens = await issueOrderTokens(c, {
        tenantId: f.tenantId, orderId: f.orderId, rentalEnd: f.rentalEnd,
      })

      // Ровно ради этого токены разные: пересланная ссылка «посмотреть»
      // не даёт постороннему отменить чужую бронь.
      expect(await resolveToken(c, tokens.view, 'view')).not.toBeNull()
      expect(await resolveToken(c, tokens.view, 'cancel')).toBeNull()
      expect(await resolveToken(c, tokens.confirm, 'view')).toBeNull()
    })
  })

  it('чужой и несуществующий токен дают null, а не подсказку', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      await issueOrderTokens(c, {
        tenantId: f.tenantId, orderId: f.orderId, rentalEnd: f.rentalEnd,
      })

      expect(await resolveToken(c, 'заведомо-не-токен', 'view')).toBeNull()
    })
  })

  it('⚠️ истёкший токен неотличим от неизвестного', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const tokens = await issueOrderTokens(c, {
        tenantId: f.tenantId, orderId: f.orderId, rentalEnd: f.rentalEnd,
      })
      await c.query(
        `UPDATE order_token SET expires_at = now() - interval '1 day'
         WHERE order_id = $1`, [f.orderId],
      )

      // Различать «истёк» и «не существует» — значит подсказывать
      // перебирающему, что такой заказ был.
      expect(await resolveToken(c, tokens.view, 'view')).toBeNull()
    })
  })

  it('locateByToken находит тенанта до контекста RLS', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const tokens = await issueOrderTokens(c, {
        tenantId: f.tenantId, orderId: f.orderId, rentalEnd: f.rentalEnd,
      })

      // ⚠️ Единственное чтение вне тенантного контекста: до разбора
      // токена неизвестно, какой app.tenant_id выставлять. Возвращает
      // только идентификаторы, никаких данных заказа.
      const found = await locateByToken(c, tokens.view, 'view')
      expect(found).toMatchObject({ tenantId: f.tenantId, orderId: f.orderId })
    })
  })
})

describe('отметка использования', () => {
  it('использованный confirm остаётся разрешимым — это повторное нажатие', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const tokens = await issueOrderTokens(c, {
        tenantId: f.tenantId, orderId: f.orderId, rentalEnd: f.rentalEnd,
      })

      await markTokenUsed(c, tokens.confirm, 'confirm')
      const r = await resolveToken(c, tokens.confirm, 'confirm')

      // ⚠️ Не ошибка: человек мог нажать «подтвердить» дважды.
      // Вызывающий видит usedAt и решает сам.
      expect(r).not.toBeNull()
      expect(r!.usedAt).not.toBeNull()
    })
  })

  it('повторная отметка не сбивает время первого использования', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const tokens = await issueOrderTokens(c, {
        tenantId: f.tenantId, orderId: f.orderId, rentalEnd: f.rentalEnd,
      })

      await markTokenUsed(c, tokens.confirm, 'confirm')
      const first = (await resolveToken(c, tokens.confirm, 'confirm'))!.usedAt
      await markTokenUsed(c, tokens.confirm, 'confirm')
      const second = (await resolveToken(c, tokens.confirm, 'confirm'))!.usedAt

      // Метка ставится только когда used_at IS NULL: иначе журнал
      // показывал бы последнее нажатие вместо первого.
      expect(second!.getTime()).toBe(first!.getTime())
    })
  })
})
