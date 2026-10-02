import 'dotenv/config'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from './schema.js'

const connectionString = process.env.DATABASE_URL
if (!connectionString) throw new Error('DATABASE_URL belum dikonfigurasi')

// Supabase transaction pooler does not support prepared statements.
const client = postgres(connectionString, { prepare: false })
export const db = drizzle({ client, schema })
export { client as dbClient }
