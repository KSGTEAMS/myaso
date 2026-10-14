// Local stack configuration. These are development-only values for services
// bound to 127.0.0.1; production secrets live in Supabase / Cloudflare.
import { createHmac } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const LOCAL_DIR = path.join(ROOT, '.local')
export const BIN_DIR = path.join(LOCAL_DIR, 'bin')
export const RUN_DIR = path.join(LOCAL_DIR, 'run')
export const STORAGE_DIR = path.join(LOCAL_DIR, 'storage')

export const PG = {
  host: process.env.LOCAL_PG_HOST ?? '127.0.0.1',
  port: Number(process.env.LOCAL_PG_PORT ?? 5432),
  user: process.env.LOCAL_PG_USER ?? 'postgres',
  password: process.env.LOCAL_PG_PASSWORD ?? 'postgres',
  database: process.env.LOCAL_PG_DB ?? 'app_local',
}

export const PORTS = {
  gateway: 54321,
  postgrest: 54331,
  auth: 54332,
  functions: 54333,
  web: 5173,
}

export const JWT_SECRET = 'local-dev-jwt-secret-at-least-32-characters-long!'
export const GATEWAY_URL = `http://127.0.0.1:${PORTS.gateway}`

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

export function signJwt(payload: Record<string, unknown>, secret = JWT_SECRET): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify(payload))
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')
  return `${header}.${body}.${sig}`
}

const longLived = { iss: 'supabase-local', iat: 1760000000, exp: 2060000000 }
export const ANON_KEY = signJwt({ ...longLived, role: 'anon' })
export const SERVICE_ROLE_KEY = signJwt({ ...longLived, role: 'service_role' })

export function dbUrl(database = PG.database, user = PG.user, password = PG.password): string {
  return `postgres://${user}:${encodeURIComponent(password)}@${PG.host}:${PG.port}/${database}`
}
