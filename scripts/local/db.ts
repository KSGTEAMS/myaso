// Database lifecycle for local development and tests: create a fresh
// database, reproduce Supabase roles, run Supabase Auth migrations, then
// apply supabase/migrations/*.sql in order.
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { BIN_DIR, PG, ROOT, dbUrl } from './config.ts'

export async function withClient<T>(database: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: dbUrl(database) })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

export function migrationFiles(): string[] {
  const dir = path.join(ROOT, 'supabase/migrations')
  return readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => path.join(dir, f))
}

function runAuthMigrations(database: string) {
  const bin = path.join(BIN_DIR, 'auth')
  if (!existsSync(bin)) throw new Error('Supabase Auth binary missing: run `npm run local:install`')
  const res = spawnSync(bin, ['migrate'], {
    cwd: BIN_DIR,
    env: {
      ...process.env,
      GOTRUE_DB_DRIVER: 'postgres',
      DATABASE_URL: `${dbUrl(database, 'supabase_auth_admin', 'auth-admin-local')}?search_path=auth`,
      GOTRUE_DB_MIGRATIONS_PATH: path.join(BIN_DIR, 'migrations'),
      GOTRUE_JWT_SECRET: 'unused-for-migrate-unused-for-migrate',
      API_EXTERNAL_URL: 'http://127.0.0.1',
      GOTRUE_SITE_URL: 'http://127.0.0.1',
      GOTRUE_LOG_LEVEL: 'error',
    },
    encoding: 'utf8',
  })
  if (res.status !== 0) throw new Error(`auth migrate failed: ${res.stderr || res.stdout}`)
}

export async function resetDatabase(database = PG.database, opts: { seed?: boolean } = {}) {
  await withClient('postgres', async (c) => {
    await c.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`, [database])
    await c.query(`drop database if exists "${database}"`)
    await c.query(`create database "${database}"`)
  })
  const bootstrap = readFileSync(path.join(ROOT, 'scripts/local/bootstrap.sql'), 'utf8')
    .replace('current_database_placeholder', `"${database}"`)
  await withClient(database, (c) => c.query(bootstrap))
  runAuthMigrations(database)
  await withClient(database, async (c) => {
    await c.query(`grant usage on schema auth to anon, authenticated, service_role;
                   grant execute on all functions in schema auth to anon, authenticated, service_role;`)
    for (const file of migrationFiles()) {
      try {
        await c.query(readFileSync(file, 'utf8'))
      } catch (e) {
        throw new Error(`${path.basename(file)}: ${(e as Error).message}`)
      }
    }
    if (opts.seed) {
      const seed = path.join(ROOT, 'supabase/seed.sql')
      if (existsSync(seed)) await c.query(readFileSync(seed, 'utf8'))
    }
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const database = process.argv[2] ?? PG.database
  resetDatabase(database, { seed: !process.argv.includes('--no-seed') })
    .then(() => console.log(`database ${database} reset`))
    .catch((e) => { console.error(e.message); process.exit(1) })
}
