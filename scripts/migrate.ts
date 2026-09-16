/**
 * Раннер миграций: сначала сгенерированные Drizzle, затем ручной SQL.
 *
 * Порядок важен: ручной SQL навешивает ограничения на таблицы, которые
 * создаёт Drizzle, — значит таблицы должны существовать.
 *
 * Ручной SQL нужен потому, что главные инварианты проекта через ORM
 * не выразить: EXCLUDE USING GIST, RLS-политики, btree_gist, CHECK
 * с подзапросами. См. ../rental-docs/docs/04-тз/10-бэкенд/11-модель-данных.md
 *
 * Запуск: npm run db:migrate
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Pool } from 'pg'

const MANUAL_DIR = join(process.cwd(), 'drizzle', 'manual')

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL не задан — скопируй .env.example в .env')

  const pool = new Pool({ connectionString: url })

  try {
    // --- 1. сгенерированные миграции Drizzle ---
    // Импортируется динамически: до первого db:generate папки может не быть.
    const hasGenerated = await readdir(join(process.cwd(), 'drizzle'))
      .then((f) => f.some((x) => x.endsWith('.sql')))
      .catch(() => false)

    if (hasGenerated) {
      const { drizzle } = await import('drizzle-orm/node-postgres')
      const { migrate } = await import('drizzle-orm/node-postgres/migrator')
      console.log('Применяю миграции Drizzle…')
      await migrate(drizzle(pool), { migrationsFolder: join(process.cwd(), 'drizzle') })
    } else {
      console.log('Сгенерированных миграций пока нет — пропускаю.')
    }

    // --- 2. ручной SQL ---
    // Журнал ведём сами: Drizzle про эти файлы не знает.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS _manual_migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `)

    const files = (await readdir(MANUAL_DIR).catch(() => []))
      .filter((f) => f.endsWith('.sql'))
      .sort() // префикс NNNN_ даёт правильный порядок

    for (const file of files) {
      const { rows } = await pool.query(
        'SELECT 1 FROM _manual_migrations WHERE name = $1',
        [file],
      )
      if (rows.length) continue

      console.log(`Применяю ручную миграцию: ${file}`)
      const body = await readFile(join(MANUAL_DIR, file), 'utf8')

      // Каждый файл в своей транзакции: либо целиком, либо никак.
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(body)
        await client.query('INSERT INTO _manual_migrations (name) VALUES ($1)', [file])
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw new Error(`Ручная миграция ${file} упала: ${(err as Error).message}`)
      } finally {
        client.release()
      }
    }

    // --- 3. пароли ролей приложения ---
    await grantRolePasswords(pool)

    console.log('Миграции применены.')
  } finally {
    await pool.end()
  }
}

/**
 * Выдаёт пароли ролям приложения из окружения.
 *
 * ⚠️ Миграции НЕ МОГУТ содержать пароли: SQL лежит в репозитории.
 * Поэтому 0003_rls.sql создаёт rental_app как NOLOGIN без пароля,
 * а 0007_worker_role.sql — rental_worker с заведомо небоевым паролем,
 * годным только для локальной разработки.
 *
 * ⚠️ Без этого шага прод не поднимался вовсе: docker-compose.prod.yml
 * подключается как rental_app:${APP_DB_PASSWORD}, а роль не имела ни
 * LOGIN, ни пароля. Отказ приходил как «password authentication
 * failed», из которого причина не следует.
 *
 * Переменных нет — шаг пропускается: на машине разработчика роли
 * работают через доверенное подключение, и требовать секреты там
 * значило бы усложнить запуск проекта ради ничего.
 */
async function grantRolePasswords(pool: Pool) {
  const roles: { role: string, password: string | undefined }[] = [
    { role: 'rental_app', password: process.env.APP_DB_PASSWORD },
    { role: 'rental_worker', password: process.env.WORKER_DB_PASSWORD },
  ]

  for (const { role, password } of roles) {
    if (!password) continue

    // ⚠️ Пароль нельзя передать параметром: ALTER ROLE не принимает
    // плейсхолдеры. Экранируем кавычки вручную и НЕ логируем значение.
    const quoted = `'${password.replaceAll("'", "''")}'`
    await pool.query(`ALTER ROLE ${role} LOGIN PASSWORD ${quoted}`)
    console.log(`Пароль роли ${role} обновлён из окружения.`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
