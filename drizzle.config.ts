import 'dotenv/config'
import { defineConfig } from 'drizzle-kit'

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL belum diisi di .env')
}

export default defineConfig({
  schema: './server/db/schema.ts',
  out: './server/db/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL },
  migrations: { schema: 'drizzle', table: '__drizzle_migrations' },
  strict: true,
  verbose: true,
})
