/**
 * ⚠️ Алиас `~` обязателен: в tsconfig он есть, но vitest его не читает —
 * без явного resolve.alias 61 файл домена не найдёт свои импорты.
 */
import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: { '~': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    // ⚠️ Тесты слоя БД идут против НАСТОЯЩЕГО Postgres: EXCLUDE USING GIST
    // и RLS в эмуляторах не существуют, и тест, проходящий без них, не
    // доказывает ничего. Отдельная база, транзакция с откатом на тест.
    setupFiles: ['./src/db/test/setup.ts'],
    // Домен трогает общие таблицы — параллельные файлы мешали бы друг другу.
    fileParallelism: false,
    testTimeout: 30_000,
  },
})
