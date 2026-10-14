// End-to-end over HTTP through the local stack: gateway -> Edge Functions ->
// PostgREST -> PostgreSQL, and Supabase Auth for the owner.
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { beforeAll, describe, expect, it } from 'vitest'
import { ANON_KEY, GATEWAY_URL, SERVICE_ROLE_KEY } from '../../scripts/local/config.ts'
import { createDispatchHandler } from '../../supabase/functions/notify-dispatch/handler.ts'
import { b64urlEncode, decryptPayload } from '../../supabase/functions/_shared/webpush.ts'
import { fixturePayload } from '../integration/helpers.ts'

const service = createClient(GATEWAY_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`

async function api(body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`${GATEWAY_URL}/functions/v1/public-api`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip(), ...headers }, body: JSON.stringify(body),
  })
  return { status: r.status, body: await r.json() as any }
}

async function newOwner(slug: string) {
  const email = `owner-${randomUUID().slice(0, 8)}@example.test`
  const password = randomUUID()
  const u = await service.auth.admin.createUser({ email, password, email_confirm: true })
  await service.rpc('add_tenant_member', { p_slug: slug, p_user_id: u.data.user!.id, p_role: 'owner' })
  const client = createClient(GATEWAY_URL, ANON_KEY, { auth: { persistSession: false } })
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw error
  return { client, jwt: data.session!.access_token }
}

let slug: string
let tenantId: string
let productId: string
let owner: Awaited<ReturnType<typeof newOwner>>

beforeAll(async () => {
  const payload = fixturePayload({ tables: 2 })
  slug = payload.slug
  const pub = await service.rpc('publish_tenant', { p_payload: payload, p_mode: 'preview' })
  if (pub.error) throw pub.error
  tenantId = pub.data.tenant_id
  owner = await newOwner(slug)
  const live = await service.rpc('publish_tenant', { p_payload: payload, p_mode: 'live' })
  if (live.error) throw live.error
  const { data } = await createClient(GATEWAY_URL, ANON_KEY).from('products').select('id,key').eq('tenant_id', tenantId)
  productId = data!.find((p) => p.key === 'ribeye')!.id
})

describe('customer flow over HTTP', () => {
  it('slots -> place (retry-safe) -> get -> ics -> reschedule -> cancel', async () => {
    const items = [{ product_id: productId, quantity: 1 }]
    const slots = await api({ action: 'slots', slug, items })
    expect(slots.status).toBe(200)
    const [s1, s2] = slots.body.slots.slice(-2)
    const key = randomUUID()
    const order = { action: 'place', slug, items, pickup_at: s1.pickup_at, idempotency_key: key, customer: { name: 'Ирина', phone: '+7 900 111-22-33' } }
    const first = await api(order)
    expect(first.status).toBe(200)
    const retry = await api(order)
    expect(retry.body.id).toBe(first.body.id)
    expect(retry.body.access_token).toBe(first.body.access_token)
    expect(first.body.customer_phone).toBe('+79001112233')

    const token = first.body.access_token
    const got = await api({ action: 'get', order_id: first.body.id, token })
    expect(got.body.number).toBe(first.body.number)
    expect((await api({ action: 'get', order_id: first.body.id, token: 'A'.repeat(43) })).status).toBe(404)

    const ics = await fetch(`${GATEWAY_URL}/functions/v1/public-api?ics=1&order_id=${first.body.id}&token=${token}`)
    expect(ics.headers.get('content-type')).toContain('text/calendar')
    expect(await ics.text()).toContain(`№${first.body.number}`)

    const moved = await api({ action: 'reschedule', order_id: first.body.id, token, pickup_at: s2.pickup_at, idempotency_key: randomUUID() })
    expect(moved.status).toBe(200)
    expect(moved.body.version).toBe(2)
    const cancelled = await api({ action: 'cancel', order_id: first.body.id, token })
    expect(cancelled.body.status).toBe('cancelled')
  })

  it('validates input and maps SQL errors to HTTP codes', async () => {
    expect((await api({ action: 'place', slug })).status).toBe(400)
    expect((await api({ action: 'slots', slug: 'missing-shop', items: [{ product_id: productId, quantity: 1 }] })).status).toBe(404)
    const slots = await api({ action: 'slots', slug, items: [{ product_id: productId, quantity: 1 }] })
    const pickup = slots.body.slots[0].pickup_at
    const mk = (n: number) => api({ action: 'place', slug, items: [{ product_id: productId, quantity: 1 }], pickup_at: pickup,
      idempotency_key: randomUUID(), customer: { name: `Гость ${n}`, phone: `+7900222000${n}` } })
    const res = [await mk(1), await mk(2), await mk(3)]
    expect(res.map((r) => r.status)).toEqual([200, 200, 409])
    expect(res[2]!.body.error).toBe('slot_taken')
  })

  it('rate limits per client address with shared counters', async () => {
    const addr = ip()
    const statuses: number[] = []
    for (let i = 0; i < 10; i++) {
      statuses.push((await api({ action: 'cancel', order_id: randomUUID(), token: 'A'.repeat(43) }, { 'x-forwarded-for': addr })).status)
    }
    expect(statuses.slice(0, 10).filter((s) => s === 404).length).toBe(10)
    const blocked = await api({ action: 'cancel', order_id: randomUUID(), token: 'A'.repeat(43) }, { 'x-forwarded-for': addr })
    expect(blocked.status).toBe(429)
    expect(blocked.body.error).toBe('rate_limited')
  })
})

describe('owner over Supabase Auth + PostgREST', () => {
  it('sees own orders, cannot read other tenants, anon cannot call owner RPCs', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const in14 = new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10)
    const sched = await owner.client.rpc('owner_schedule', { p_tenant: tenantId, p_from: today, p_to: in14 })
    expect(sched.error).toBeNull()
    expect(sched.data.orders.length).toBeGreaterThan(0)

    const otherPayload = fixturePayload()
    const other = await service.rpc('publish_tenant', { p_payload: otherPayload, p_mode: 'preview' })
    const denied = await owner.client.rpc('owner_stats', { p_tenant: other.data.tenant_id, p_period: 'today' })
    expect(denied.error?.message).toBe('forbidden')

    const anon = createClient(GATEWAY_URL, ANON_KEY)
    const a = await anon.rpc('owner_stats', { p_tenant: tenantId, p_period: 'today' })
    expect(a.error?.code).toBe('42501')
    const leak = await anon.from('orders').select('id')
    expect(leak.error?.code).toBe('42501')
  })
})

describe('AI endpoint scopes (no LLM configured -> deterministic answers)', () => {
  const chat = (body: unknown, jwt?: string) => fetch(`${GATEWAY_URL}/functions/v1/ai-chat`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip(), ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) },
  }).then(async (r) => ({ status: r.status, body: await r.json() as any }))

  it('owner gets stats from the SQL tool; client scope cannot reach owner tools', async () => {
    const o = await chat({ slug, scope: 'owner', messages: [{ role: 'user', content: 'Сколько оплат получили сегодня?' }] }, owner.jwt)
    expect(o.status).toBe(200)
    expect(o.body.tools[0]).toMatchObject({ name: 'stats', ok: true, forced: true })
    expect(o.body.answer).toContain('Получено оплат')

    const c = await chat({ slug, scope: 'client', messages: [{ role: 'user', content: 'Какая у вас выручка за неделю?' }] })
    expect(c.status).toBe(200)
    expect(c.body.tools.map((t: { name: string }) => t.name)).not.toContain('stats')

    expect((await chat({ slug, scope: 'owner', messages: [{ role: 'user', content: 'выручка' }] })).status).toBe(401)
    // A signed-in user who is not a member of this tenant is refused.
    const stranger = await newOwner(fixturePayload().slug)
    expect((await chat({ slug, scope: 'owner', messages: [{ role: 'user', content: 'выручка' }] }, stranger.jwt)).status).toBe(403)
  })
})

describe('outbox -> encrypted Web Push', () => {
  it('delivers the owner notification once, with a payload the browser can decrypt', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
    const auth = crypto.getRandomValues(new Uint8Array(16))
    const endpoint = `https://push.example.test/${randomUUID()}`
    const reg = await owner.client.rpc('owner_register_push', { p_tenant: tenantId,
      p_subscription: { endpoint, keys: { p256dh: b64urlEncode(raw), auth: b64urlEncode(auth) } } })
    expect(reg.error).toBeNull()

    const slots = await api({ action: 'slots', slug, items: [{ product_id: productId, quantity: 1 }] })
    const placed = await api({ action: 'place', slug, items: [{ product_id: productId, quantity: 1 }], pickup_at: slots.body.slots[3].pickup_at,
      idempotency_key: randomUUID(), customer: { name: 'Push Test', phone: '+79003334455' } })
    expect(placed.status).toBe(200)

    const delivered: Array<{ url: string; body: Uint8Array }> = []
    const fakePushService = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === endpoint) delivered.push({ url: String(url), body: new Uint8Array(init!.body as ArrayBuffer) })
      return new Response(null, { status: 201 })
    }) as typeof fetch
    const keys = await import('../../supabase/functions/_shared/webpush.ts').then((m) => m.generateVapidKeys())
    const env = (k: string) => ({ CRON_SECRET: 's', VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, PUBLIC_APP_URL: 'https://app.test' } as Record<string, string>)[k]
    const handler = createDispatchHandler({ env, service, fetchImpl: fakePushService, workerId: 'test-worker' })

    expect((await handler(new Request('http://x', { method: 'POST', headers: { 'x-cron-secret': 'wrong' } }))).status).toBe(403)
    const run = await (await handler(new Request('http://x', { method: 'POST', headers: { 'x-cron-secret': 's' } }))).json()
    expect(run.claimed).toBeGreaterThan(0)
    const decode = async () => Promise.all(delivered.map(async (d) =>
      JSON.parse(new TextDecoder().decode(await decryptPayload(d.body, pair.privateKey, raw, auth)))))
    // Every pending owner event of this tenant is delivered (earlier tests left some).
    const msgs = await decode()
    const created = msgs.filter((m) => m.title === `Новый заказ №${placed.body.number}`)
    expect(created).toHaveLength(1)
    expect(created[0].url).toBe(`https://app.test/s/${slug}/owner/orders/${placed.body.id}`)
    expect(new Set(msgs.map((m) => `${m.title}|${m.body}`)).size).toBe(msgs.length)

    // Second run: nothing is sent twice.
    const before = delivered.length
    await handler(new Request('http://x', { method: 'POST', headers: { 'x-cron-secret': 's' } }))
    expect(delivered.length).toBe(before)
  })
})
