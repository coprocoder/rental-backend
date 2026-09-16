/**
 * Пустой `app.tenant_id` не должен ронять запрос.
 *
 * ⚠️ Дефект со стенда: клиент открывал свою же ссылку из письма и
 * получал «Ссылка не открылась / Server Error». В логах —
 * `invalid input syntax for type uuid: ""`.
 *
 * Цепочка: `SET LOCAL app.tenant_id` после COMMIT сбрасывается НЕ в
 * NULL, а в ПУСТУЮ СТРОКУ. Соединение возвращается в пул с
 * `app.tenant_id = ''`, и следующий запрос на нём без тенантного
 * контекста (разбор клиентского токена — единственный законный случай)
 * попадал на политику `tenant_id = current_setting(...)::uuid`.
 * Приведение '' к uuid не возвращает пусто, а БРОСАЕТ ошибку.
 *
 * ⚠️ Локально не воспроизводилось: тесты и dev ходят под владельцем БД,
 * а владелец политики ОБХОДИТ — ни одна не вычисляется. Разница между
 * dev и продом была не в коде, а в РОЛИ. Поэтому здесь проверяется
 * САМА ФУНКЦИЯ `app_tenant_id()`, а не поведение через политику:
 * функция вычисляется одинаково под любой ролью.
 *
 * Спека: ../rental-docs/docs/04-тз/10-бэкенд/17-доступ-и-роли.md
 */
import { describe, expect, it } from 'vitest'
import { inRollback } from './setup'

describe('app_tenant_id(): пустая настройка не ломает приведение', () => {
  it('пустая строка даёт NULL, а не ошибку', async () => {
    await inRollback(async (c) => {
      await c.query(`SELECT set_config('app.tenant_id', '', true)`)
      const { rows } = await c.query<{ v: string | null }>(
        'SELECT app_tenant_id() AS v',
      )
      expect(rows[0]?.v).toBeNull()
    })
  })

  it('незаданная настройка тоже даёт NULL', async () => {
    await inRollback(async (c) => {
      const { rows } = await c.query<{ v: string | null }>(
        'SELECT app_tenant_id() AS v',
      )
      expect(rows[0]?.v).toBeNull()
    })
  })

  it('заданный тенант возвращается как uuid', async () => {
    await inRollback(async (c) => {
      const { rows: t } = await c.query<{ id: string }>(
        `INSERT INTO tenant (slug, name)
         VALUES ('t-' || gen_random_uuid(), 'Тест') RETURNING id`,
      )
      // ⚠️ Тенант достаём до сравнения: с `t[0]?.id` обе стороны могли бы
      // оказаться undefined, и тест прошёл бы, ничего не проверив.
      const tenantId = t[0]?.id
      expect(tenantId).toBeDefined()
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId])
      const { rows } = await c.query<{ v: string }>('SELECT app_tenant_id() AS v')
      expect(rows[0]?.v).toBe(tenantId)
    })
  })

  it('⚠️ ни одна политика не приводит app.tenant_id к uuid напрямую', async () => {
    // Регрессия на будущее: новая политика со старым выражением вернёт
    // дефект ровно в той таблице, где её добавили. Приведение живёт
    // в одном месте — в app_tenant_id().
    await inRollback(async (c) => {
      const { rows } = await c.query<{ polname: string, tbl: string }>(
        `SELECT pol.polname, cl.relname AS tbl
         FROM pg_policy pol
         JOIN pg_class cl ON cl.oid = pol.polrelid
         WHERE pg_get_expr(pol.polqual, pol.polrelid) LIKE '%app.tenant_id%::uuid%'
            OR pg_get_expr(pol.polwithcheck, pol.polrelid) LIKE '%app.tenant_id%::uuid%'`,
      )
      expect(rows.map((r) => `${r.tbl}.${r.polname}`)).toEqual([])
    })
  })

  it('⚠️ изоляция не ослабла: без тенанта политика НЕ пропускает', async () => {
    // Важно, что NULL даёт ОТКАЗ, а не доступ: `tenant_id = NULL` —
    // это NULL, то есть строка политику не проходит. Fail closed.
    await inRollback(async (c) => {
      await c.query(`SELECT set_config('app.tenant_id', '', true)`)
      const { rows } = await c.query<{ ok: boolean | null }>(
        `SELECT ('11111111-1111-1111-1111-111111111111'::uuid = app_tenant_id()) AS ok`,
      )
      expect(rows[0]?.ok).toBeNull()
    })
  })
})
