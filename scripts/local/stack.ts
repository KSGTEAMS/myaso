// Start/stop the local stack: PostgREST, Supabase Auth, Edge Functions (Deno)
// and the gateway. PostgreSQL itself is expected to be running already.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { generateVapidKeys } from '../../supabase/functions/_shared/webpush.ts'
import { resetDatabase } from './db.ts'
import { ANON_KEY, BIN_DIR, GATEWAY_URL, JWT_SECRET, LOCAL_DIR, PG, PORTS, ROOT, RUN_DIR, SERVICE_ROLE_KEY, dbUrl } from './config.ts'

const CRON_SECRET = 'local-cron-secret'

function loadDotEnv(): Record<string, string> {
  const file = path.join(ROOT, '.env')
  if (!existsSync(file)) return {}
  return Object.fromEntries(readFileSync(file, 'utf8').split('\n')
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)).filter(Boolean)
    .map((m) => [m![1]!, m![2]!.replace(/^['"]|['"]$/g, '')]))
}

async function vapid() {
  const file = path.join(LOCAL_DIR, 'vapid.json')
  if (!existsSync(file)) writeFileSync(file, JSON.stringify(await generateVapidKeys()))
  return JSON.parse(readFileSync(file, 'utf8')) as { publicKey: string; privateKey: string }
}

async function dbExists(): Promise<boolean> {
  const c = new pg.Client({ connectionString: dbUrl('postgres') })
  await c.connect()
  const r = await c.query('select 1 from pg_database where datname = $1', [PG.database])
  await c.end()
  return r.rowCount === 1
}

function launch(name: string, cmd: string, args: string[], env: Record<string, string>, cwd = ROOT) {
  const log = openSync(path.join(RUN_DIR, `${name}.log`), 'a')
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', log, log] })
  child.unref()
  writeFileSync(path.join(RUN_DIR, `${name}.pid`), String(child.pid))
}

async function waitFor(url: string, name: string, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.status < 500) return } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`${name} did not start; see .local/run/${name}.log`)
}

/** Demo owner accounts for the local stack only (password: demo-<slug>-owner). */
async function seedOwners() {
  const { readRegistry, loadBusiness } = await import('../lib/tenant.ts')
  const { inviteOwner } = await import('../owner-invite.ts')
  for (const e of readRegistry()) {
    const email = loadBusiness(e.slug).business?.owner?.email
    if (!email) continue
    await inviteOwner({ slug: e.slug, email, password: `demo-${e.slug}-owner` },
      { url: GATEWAY_URL, serviceKey: SERVICE_ROLE_KEY, anonKey: ANON_KEY, local: true })
    console.log(`  demo owner ${email} / demo-${e.slug}-owner -> /s/${e.slug}/owner/`)
  }
}

export function stop() {
  if (!existsSync(RUN_DIR)) return
  for (const name of ['gateway', 'functions', 'auth', 'postgrest']) {
    const pidFile = path.join(RUN_DIR, `${name}.pid`)
    if (!existsSync(pidFile)) continue
    try { process.kill(-Number(readFileSync(pidFile, 'utf8')), 'SIGTERM') } catch { /* already gone */ }
    rmSync(pidFile)
  }
}

export async function start(opts: { reset?: boolean } = {}) {
  mkdirSync(RUN_DIR, { recursive: true })
  stop()
  const fresh = opts.reset || !(await dbExists())
  if (fresh) await resetDatabase(PG.database, { seed: true })
  const keys = await vapid()
  const dot = loadDotEnv()

  launch('postgrest', path.join(BIN_DIR, 'postgrest'), [], {
    PGRST_DB_URI: dbUrl(PG.database, 'authenticator', 'authenticator-local'),
    PGRST_DB_SCHEMAS: 'public', PGRST_DB_ANON_ROLE: 'anon', PGRST_JWT_SECRET: JWT_SECRET,
    PGRST_DB_EXTRA_SEARCH_PATH: 'public,extensions', PGRST_SERVER_PORT: String(PORTS.postgrest),
    PGRST_SERVER_HOST: '127.0.0.1', PGRST_DB_POOL: '10',
  })
  launch('auth', path.join(BIN_DIR, 'auth'), ['serve'], {
    GOTRUE_API_HOST: '127.0.0.1', PORT: String(PORTS.auth), API_EXTERNAL_URL: `${GATEWAY_URL}/auth/v1`,
    GOTRUE_DB_DRIVER: 'postgres', DATABASE_URL: `${dbUrl(PG.database, 'supabase_auth_admin', 'auth-admin-local')}?search_path=auth`,
    GOTRUE_DB_MIGRATIONS_PATH: path.join(BIN_DIR, 'migrations'), GOTRUE_SITE_URL: `http://localhost:${PORTS.web}`,
    GOTRUE_JWT_SECRET: JWT_SECRET, GOTRUE_JWT_EXP: '3600', GOTRUE_JWT_AUD: 'authenticated',
    GOTRUE_JWT_DEFAULT_GROUP_NAME: 'authenticated', GOTRUE_JWT_ADMIN_ROLES: 'service_role',
    GOTRUE_DISABLE_SIGNUP: 'true', GOTRUE_EXTERNAL_EMAIL_ENABLED: 'true', GOTRUE_MAILER_AUTOCONFIRM: 'true',
    GOTRUE_LOG_LEVEL: 'warn',
  }, BIN_DIR)
  launch('functions', 'deno', ['run', '--watch', '--allow-net', '--allow-env', '--allow-read', '--config', 'supabase/functions/deno.json',
    'scripts/local/functions-server.ts'], {
    SUPABASE_URL: GATEWAY_URL, SUPABASE_ANON_KEY: ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
    FUNCTIONS_PORT: String(PORTS.functions), CRON_SECRET, IP_HASH_SALT: 'local-salt',
    VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: 'mailto:dev@localhost',
    PUBLIC_APP_URL: `http://localhost:${PORTS.web}`,
    ...Object.fromEntries(Object.entries(dot).filter(([k]) => k.startsWith('LLM_'))),
  })
  launch('gateway', 'npx', ['tsx', 'scripts/local/gateway.ts'], {})

  await waitFor(`http://127.0.0.1:${PORTS.postgrest}/`, 'postgrest')
  await waitFor(`http://127.0.0.1:${PORTS.auth}/health`, 'auth')
  await waitFor(`http://127.0.0.1:${PORTS.functions}/health`, 'functions', 60000)
  await waitFor(`${GATEWAY_URL}/rest/v1/`, 'gateway')

  if (fresh) await seedOwners()
  writeFileSync(path.join(ROOT, '.env.development.local'), [
    '# generated by `npm run local:start` — local stack only',
    `VITE_SUPABASE_URL=${GATEWAY_URL}`,
    `VITE_SUPABASE_ANON_KEY=${ANON_KEY}`,
    `VITE_VAPID_PUBLIC_KEY=${keys.publicKey}`,
    '',
  ].join('\n'))
  console.log(`local stack up: ${GATEWAY_URL}\n  anon key and VAPID public key written to .env.development.local\n  cron secret (for notify-dispatch): ${CRON_SECRET}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2]
  if (cmd === 'stop') stop()
  else if (cmd === 'status') {
    for (const n of ['postgrest', 'auth', 'functions', 'gateway']) {
      const f = path.join(RUN_DIR, `${n}.pid`)
      let up = false
      if (existsSync(f)) { try { process.kill(Number(readFileSync(f, 'utf8')), 0); up = true } catch { /* dead */ } }
      console.log(`${n.padEnd(10)} ${up ? 'running' : 'stopped'}`)
    }
  } else start({ reset: process.argv.includes('--reset') }).catch((e) => { console.error(e.message); process.exit(1) })
}
