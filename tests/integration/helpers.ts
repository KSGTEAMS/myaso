// Helpers for SQL integration tests against a real PostgreSQL with the
// production migrations applied. Roles are switched with SET LOCAL ROLE and
// request.jwt.claims exactly like PostgREST does.
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { dbUrl } from '../../scripts/local/config.ts'

export const TEST_DB = 'app_test'
export const pool = new pg.Pool({ connectionString: dbUrl(TEST_DB), max: 20 })

export async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(sql, params)
  return res.rows as T[]
}

export async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  const rows = await q<T>(sql, params)
  if (rows.length !== 1) throw new Error(`expected 1 row, got ${rows.length}`)
  return rows[0]!
}

/** Run SQL as a PostgREST role inside a transaction that is rolled back unless commit=true. */
export async function asRole<T>(
  role: 'anon' | 'authenticated' | 'service_role',
  claims: Record<string, unknown>,
  fn: (c: pg.PoolClient) => Promise<T>,
  commit = false,
): Promise<T> {
  const c = await pool.connect()
  try {
    await c.query('begin')
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role, ...claims })])
    await c.query(`set local role ${role}`)
    const out = await fn(c)
    await c.query(commit ? 'commit' : 'rollback')
    return out
  } catch (e) {
    await c.query('rollback').catch(() => {})
    throw e
  } finally {
    c.release()
  }
}

export async function rpc<T = any>(fn: string, args: Record<string, unknown>, client?: pg.PoolClient): Promise<T> {
  const names = Object.keys(args)
  const sql = `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as r`
  const values = names.map((n) => {
    const v = args[n]
    return v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v
  })
  const res = await (client ?? pool).query(sql, values)
  return res.rows[0].r as T
}

export async function expectFail(p: Promise<unknown>, code: string) {
  try {
    await p
  } catch (e) {
    const msg = (e as Error).message
    if (msg !== code) throw new Error(`expected ${code}, got ${msg}`)
    return
  }
  throw new Error(`expected failure ${code}, but call succeeded`)
}

export interface FixtureOptions {
  slug?: string
  timezone?: string
  opens?: string
  closes?: string
  minNotice?: number
  cancelNotice?: number
  tables?: number
  status?: 'preview' | 'live'
  exceptions?: Array<{ day: string; is_closed?: boolean; opens?: string; closes?: string }>
}

export function fixturePayload(o: FixtureOptions = {}) {
  const slug = o.slug ?? `t-${randomUUID().slice(0, 8)}`
  const tables = Array.from({ length: o.tables ?? 2 }, (_, i) => ({
    key: `table-${i + 1}`, name: `Стол ${i + 1}`, kind: 'cutting_table',
  }))
  return {
    slug,
    name: `Test ${slug}`,
    timezone: o.timezone ?? 'UTC',
    currency: 'RUB',
    locale: 'ru-RU',
    config_hash: randomUUID(),
    ordering: {
      pickup_step_minutes: 30,
      min_notice_minutes: o.minNotice ?? 0,
      horizon_days: 30,
      cancel_notice_minutes: o.cancelNotice ?? 60,
      max_order_lines: 10,
    },
    profile: { accent: '#B4442C', contacts: { phone: '+70000000000', address: 'Test street 1' } },
    hours: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, opens: o.opens ?? '08:00', closes: o.closes ?? '20:00' })),
    exceptions: o.exceptions ?? [],
    resources: [...tables, { key: 'smokehouse', name: 'Коптильня', kind: 'smokehouse' }],
    prep_profiles: [
      { key: 'cut', name: 'Разделка', base_minutes: 20, per_kg_minutes: 4, buffer_minutes: 10,
        resources: tables.map((t) => t.key) },
      { key: 'smoke', name: 'Копчение', base_minutes: 2880, buffer_minutes: 60, resources: ['smokehouse'] },
    ],
    categories: [{ key: 'beef', name: 'Говядина' }, { key: 'smoked', name: 'Копчёное' }],
    products: [
      { key: 'ribeye', category: 'beef', prep: 'cut', name: 'Рибай', unit: 'kg', price_cents: 289000,
        qty_step: 0.25, min_qty: 0.5, max_qty: 5, image_path: 'pipeline/ribeye.jpg' },
      { key: 'mince', category: 'beef', prep: 'cut', name: 'Фарш', unit: 'kg', price_cents: 89000,
        qty_step: 0.5, min_qty: 0.5, max_qty: 10 },
      { key: 'brisket-smoked', category: 'smoked', prep: 'smoke', name: 'Брискет копчёный', unit: 'pcs',
        price_cents: 450000, qty_step: 1, min_qty: 1, max_qty: 2 },
    ],
  }
}

export interface Fixture {
  slug: string
  tenantId: string
  products: Record<string, string>
  resources: Record<string, string>
  payload: ReturnType<typeof fixturePayload>
}

export async function createTenant(o: FixtureOptions = {}): Promise<Fixture> {
  const payload = fixturePayload(o)
  const res = await rpc('publish_tenant', { p_payload: payload, p_mode: 'preview' })
  const tenantId = res.tenant_id as string
  if (o.status === 'live') {
    // Live tenants need an owner; create one and republish in live mode.
    await createOwner(tenantId)
    await rpc('publish_tenant', { p_payload: payload, p_mode: 'live' })
  }
  const products = Object.fromEntries((await q<{ key: string; id: string }>(
    'select key, id from public.products where tenant_id = $1', [tenantId])).map((r) => [r.key, r.id]))
  const resources = Object.fromEntries((await q<{ key: string; id: string }>(
    'select key, id from public.resources where tenant_id = $1', [tenantId])).map((r) => [r.key, r.id]))
  return { slug: payload.slug, tenantId, products, resources, payload }
}

export async function createOwner(tenantId: string): Promise<string> {
  const userId = randomUUID()
  await q(`insert into auth.users (id, email, aud, role, created_at) values ($1, $2, 'authenticated', 'authenticated', now())`,
    [userId, `${userId}@example.test`])
  await q(`insert into public.tenant_members (tenant_id, user_id, role) values ($1, $2, 'owner')
           on conflict do nothing`, [tenantId, userId])
  return userId
}

/** Owner claims as PostgREST would set them for a signed-in user. */
export function ownerClaims(userId: string) {
  return { sub: userId, role: 'authenticated' }
}

export const customer = (n = 1) => ({ name: `Покупатель ${n}`, phone: `+7900000${String(n).padStart(4, '0')}` })

/** Next pickup moment on the tenant grid at least `hoursAhead` from now (local hour granularity). */
export async function slotAt(f: Fixture, items: unknown, minHoursAhead = 3): Promise<string> {
  const res = await rpc('get_pickup_slots', { p_slug: f.slug, p_items: items, p_from: null, p_to: null })
  const slot = (res.slots as Array<{ pickup_at: string }>).find(
    (s) => new Date(s.pickup_at).getTime() >= Date.now() + minHoursAhead * 3600_000)
  if (!slot) throw new Error('no slot found')
  return slot.pickup_at
}

export const ribeye = (f: Fixture, qty = 1) => [{ product_id: f.products.ribeye, quantity: qty }]
export const brisket = (f: Fixture) => [{ product_id: f.products['brisket-smoked'], quantity: 1 }]
export const key = () => randomUUID()
