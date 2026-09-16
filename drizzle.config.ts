import type { Config } from 'drizzle-kit'

// ⚠️ Только generate, никогда push: push сносит EXCLUDE-ограничения,
// а drizzle-kit check этого не замечает.
export default {
  schema: './server/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
} satisfies Config
