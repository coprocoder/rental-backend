import type { Config } from 'drizzle-kit'

// ⚠️ Только generate, никогда push: push сносит EXCLUDE-ограничения,
// а drizzle-kit check этого не замечает (железное правило 11).
//
// ⚠️ `generate` НЕ РАБОТАЛ, и это выяснилось только при проверке.
// Две причины, обе оставлены переездом:
//   1) `schema` указывал на `./server/db/schema.ts` — каталог Nuxt,
//      которого в этом репозитории нет;
//   2) drizzle-kit 0.28 падал на `target: "ES2023"` из `tsconfig.json`
//      («Invalid target "es2023"») — внутри у него старый esbuild.
//
// ⚠️ Почему не замечали: накат (`npm run db:migrate`) читает ГОТОВЫЕ
// `.sql` и работал исправно — сломан был только генератор новых. Все
// миграции после переезда писались руками, так что повода запустить
// `generate` не возникало.
//
// Вылечено обновлением drizzle-kit до 0.31, а не понижением `target`:
// менять цель компиляции сервиса под чужую проблему — не то же самое,
// что починить инструмент. Проверено: генерация проходит и видит все
// 40 таблиц.
export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
} satisfies Config
