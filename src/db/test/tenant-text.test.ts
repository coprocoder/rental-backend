/**
 * Версионирование текстов тенанта (13.14).
 *
 * ⚠️ Проверяется на НАСТОЯЩЕМ Postgres: главное здесь — частичный
 * уникальный индекс «одна действующая редакция на вид». Это инвариант
 * в БД, а не проверка в коде (железное правило №2), и эмулятор его
 * не воспроизведёт.
 *
 * Почему инвариант важен: две действующие оферты означают, что
 * неизвестно, какую подписал клиент, — и подпись перестаёт что-либо
 * доказывать в споре.
 */
import { describe, expect, it } from 'vitest'
import { inRollback } from './setup'

async function tenant(c: import('pg').PoolClient): Promise<string> {
  const { rows } = await c.query(
    `INSERT INTO tenant (slug, name) VALUES ('t-' || gen_random_uuid(), 'Тест')
     RETURNING id`,
  )
  return rows[0].id as string
}

describe('tenant_text', () => {
  it('не допускает двух действующих редакций одного вида', async () => {
    await inRollback(async (c) => {
      const t = await tenant(c)
      await c.query(
        `INSERT INTO tenant_text (tenant_id, kind, version, body, hash, is_active)
         VALUES ($1, 'offer', 1, 'первая', 'h1', true)`,
        [t],
      )

      // ⚠️ Вторая действующая должна быть отвергнута БАЗОЙ, а не кодом:
      // проверка в приложении гонку не закрывает, и две вкладки админки
      // создали бы две действующие оферты.
      await expect(c.query(
        `INSERT INTO tenant_text (tenant_id, kind, version, body, hash, is_active)
         VALUES ($1, 'offer', 2, 'вторая', 'h2', true)`,
        [t],
      )).rejects.toMatchObject({ code: '23505' })
    })
  })

  it('разрешает много НЕдействующих редакций: история не удаляется', async () => {
    await inRollback(async (c) => {
      const t = await tenant(c)
      await c.query(
        `INSERT INTO tenant_text (tenant_id, kind, version, body, hash, is_active)
         VALUES ($1, 'offer', 1, 'первая', 'h1', false),
                ($1, 'offer', 2, 'вторая', 'h2', false),
                ($1, 'offer', 3, 'третья', 'h3', true)`,
        [t],
      )
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM tenant_text WHERE tenant_id = $1`, [t],
      )
      expect(rows[0].n).toBe(3)
    })
  })

  it('разные виды текстов не мешают друг другу', async () => {
    await inRollback(async (c) => {
      const t = await tenant(c)
      // Действующая оферта И действующая политика — это норма.
      await c.query(
        `INSERT INTO tenant_text (tenant_id, kind, version, body, hash, is_active)
         VALUES ($1, 'offer', 1, 'оферта', 'h1', true),
                ($1, 'privacy', 1, 'политика', 'h2', true)`,
        [t],
      )
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM tenant_text WHERE tenant_id = $1 AND is_active`,
        [t],
      )
      expect(rows[0].n).toBe(2)
    })
  })

  it('номер редакции уникален внутри вида', async () => {
    await inRollback(async (c) => {
      const t = await tenant(c)
      await c.query(
        `INSERT INTO tenant_text (tenant_id, kind, version, body, hash, is_active)
         VALUES ($1, 'offer', 1, 'первая', 'h1', false)`,
        [t],
      )
      // Иначе «редакция №1» перестаёт однозначно указывать на текст,
      // а именно на неё ссылается подписанный договор.
      await expect(c.query(
        `INSERT INTO tenant_text (tenant_id, kind, version, body, hash, is_active)
         VALUES ($1, 'offer', 1, 'другая первая', 'h2', false)`,
        [t],
      )).rejects.toMatchObject({ code: '23505' })
    })
  })

  it('вид текста ограничен списком: опечатка не заведёт мёртвый вид', async () => {
    await inRollback(async (c) => {
      const t = await tenant(c)
      await expect(c.query(
        `INSERT INTO tenant_text (tenant_id, kind, version, body, hash)
         VALUES ($1, 'oferta', 1, 'текст', 'h')`,
        [t],
      )).rejects.toMatchObject({ code: '23514' })
    })
  })
})
