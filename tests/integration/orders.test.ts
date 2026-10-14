import { afterAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { dbUrl } from '../../scripts/local/config.ts'
import {
  TEST_DB, brisket, createOwner, createTenant, customer, expectFail, key, one, ownerClaims, pool, q, ribeye,
  rpc, slotAt, asRole,
} from './helpers.ts'

afterAll(() => pool.end())

const place = (slug: string, items: unknown, pickup: string, n = 1, k = key()) =>
  rpc('place_order', { p_slug: slug, p_items: items, p_pickup_at: pickup, p_customer: customer(n), p_idempotency_key: k })

describe('concurrent orders', () => {
  it('lets exactly as many orders through as there are free resources', async () => {
    const f = await createTenant({ tables: 2 })
    const pickup = await slotAt(f, ribeye(f))
    // Separate connections, released together: real parallel transactions.
    const clients = await Promise.all(Array.from({ length: 6 }, async () => {
      const c = new pg.Client({ connectionString: dbUrl(TEST_DB) })
      await c.connect()
      return c
    }))
    const results = await Promise.allSettled(clients.map((c, i) =>
      c.query(`select public.place_order($1, $2, $3, $4, $5) as r`,
        [f.slug, JSON.stringify(ribeye(f)), pickup, JSON.stringify(customer(i + 1)), key()])))
    await Promise.all(clients.map((c) => c.end()))

    const ok = results.filter((r) => r.status === 'fulfilled')
    const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
    expect(ok).toHaveLength(2)
    expect(failed.map((r) => (r.reason as Error).message)).toEqual(Array(4).fill('slot_taken'))

    const occ = await q<{ resource_id: string }>(
      `select o.resource_id from public.resource_occupancies o join public.orders x on x.id = o.order_id
       where x.tenant_id = $1`, [f.tenantId])
    expect(new Set(occ.map((o) => o.resource_id)).size).toBe(2)
    // Order numbers stay unique and gap-free for the successful ones.
    const numbers = await q<{ number: number }>('select number from public.orders where tenant_id = $1 order by number', [f.tenantId])
    expect(numbers.map((r) => r.number)).toEqual([1, 2])
  })

  it('never stores overlapping ranges on one resource (EXCLUDE constraint)', async () => {
    const f = await createTenant({ tables: 1 })
    const pickup = await slotAt(f, ribeye(f))
    await place(f.slug, ribeye(f), pickup)
    await expect(q(`insert into public.resource_occupancies (tenant_id, resource_id, period, order_id, prep_profile_id)
       select tenant_id, resource_id, period, order_id, (select id from public.prep_profiles where tenant_id = $1 and key = 'smoke')
       from public.resource_occupancies where tenant_id = $1 limit 1`, [f.tenantId]))
      .rejects.toThrow(/resource_occupancies_no_overlap/)
  })
})

describe('two resources and eligibility', () => {
  it('uses the second table, then rejects the third order, and accepts another time', async () => {
    const f = await createTenant({ tables: 2 })
    const pickup = await slotAt(f, ribeye(f))
    const a = await place(f.slug, ribeye(f), pickup, 1)
    const b = await place(f.slug, ribeye(f), pickup, 2)
    expect(a.preparation[0].resource_id).not.toBe(b.preparation[0].resource_id)
    await expectFail(place(f.slug, ribeye(f), pickup, 3), 'slot_taken')

    const slots = await rpc('get_pickup_slots', { p_slug: f.slug, p_items: ribeye(f), p_from: null, p_to: null })
    const times = (slots.slots as Array<{ pickup_at: string }>).map((s) => new Date(s.pickup_at).getTime())
    expect(times).not.toContain(new Date(pickup).getTime())
    // 35 min occupancy: the next free moment is at least 30 min away on a 30 min grid
    const later = new Date(times.find((t) => t > new Date(pickup).getTime())!).toISOString()
    const c = await place(f.slug, ribeye(f), later, 3)
    expect(c.status).toBe('confirmed')
  })

  it('splits a mixed cart into one occupancy per prep group on suitable resources', async () => {
    const f = await createTenant({ tables: 1 })
    const items = [...ribeye(f), ...brisket(f)]
    const pickup = await slotAt(f, items, 49)
    const o = await place(f.slug, items, pickup)
    const kinds = await q<{ kind: string; minutes: number }>(
      `select r.kind, extract(epoch from upper(o.period) - lower(o.period)) / 60 as minutes
       from public.resource_occupancies o join public.resources r on r.id = o.resource_id
       where o.order_id = $1 order by r.kind`, [o.id])
    expect(kinds.map((k) => k.kind)).toEqual(['cutting_table', 'smokehouse'])
    expect(Number(kinds[1]!.minutes)).toBe(2880 + 60)
    // all groups end exactly at pickup
    const ends = await q<{ e: Date }>('select upper(period) as e from public.resource_occupancies where order_id = $1', [o.id])
    expect(ends.every((r) => r.e.toISOString() === new Date(pickup).toISOString())).toBe(true)
  })

  it('rejects products whose prep profile has no active resource', async () => {
    const f = await createTenant()
    await q(`update public.resources set is_active = false where tenant_id = $1 and key = 'smokehouse'`, [f.tenantId])
    await expectFail(rpc('get_pickup_slots', { p_slug: f.slug, p_items: brisket(f), p_from: null, p_to: null })
      .then((r) => { if (r.slots.length === 0) throw new Error('no_slots'); return r }), 'no_slots')
  })
})

describe('multi-day occupancy', () => {
  it('blocks the smokehouse for the whole range including buffer, across days', async () => {
    const f = await createTenant()
    const slots = await rpc('get_pickup_slots', { p_slug: f.slug, p_items: brisket(f), p_from: null, p_to: null })
    const first = new Date(slots.slots[0].pickup_at).getTime()
    expect(first).toBeGreaterThanOrEqual(Date.now() + (2880 + 60) * 60_000 - 60_000)

    const pickup = slots.slots[2].pickup_at as string
    const o = await place(f.slug, brisket(f), pickup)
    const range = await one<{ lo: Date; hi: Date }>(
      'select lower(period) lo, upper(period) hi from public.resource_occupancies where order_id = $1', [o.id])
    expect(range.hi.getTime() - range.lo.getTime()).toBe((2880 + 60) * 60_000)
    expect(range.lo.toISOString().slice(0, 10)).not.toBe(range.hi.toISOString().slice(0, 10))

    // A pickup one day later overlaps the 49h range on the single smokehouse.
    const dayLater = new Date(new Date(pickup).getTime() + 24 * 3600_000).toISOString()
    await expectFail(place(f.slug, brisket(f), dayLater, 2), 'slot_taken')
    // ...but the cutting tables are unaffected.
    const cut = await place(f.slug, ribeye(f), await slotAt(f, ribeye(f)), 3)
    expect(cut.status).toBe('confirmed')
  })
})

describe('owner blocks share the occupancy table', () => {
  it('a block makes the resource unavailable and cannot overlap an order', async () => {
    const f = await createTenant({ tables: 1 })
    const owner = await createOwner(f.tenantId)
    const pickup = await slotAt(f, ribeye(f), 5)
    const start = new Date(new Date(pickup).getTime() - 2 * 3600_000).toISOString()
    const end = new Date(new Date(pickup).getTime() + 3600_000).toISOString()

    const block = await asRole('authenticated', ownerClaims(owner), (c) =>
      rpc('owner_create_block', { p_tenant: f.tenantId, p_resource_id: f.resources['table-1'], p_starts_at: start,
        p_ends_at: end, p_reason: 'Санобработка', p_idempotency_key: key() }, c), true)
    expect(block.replayed).toBe(false)
    await expectFail(place(f.slug, ribeye(f), pickup), 'slot_taken')

    // Overlapping second block -> resource_busy
    await expectFail(asRole('authenticated', ownerClaims(owner), (c) =>
      rpc('owner_create_block', { p_tenant: f.tenantId, p_resource_id: f.resources['table-1'], p_starts_at: start,
        p_ends_at: end, p_reason: 'x', p_idempotency_key: key() }, c)), 'resource_busy')

    await asRole('authenticated', ownerClaims(owner), (c) =>
      rpc('owner_delete_block', { p_tenant: f.tenantId, p_block_id: block.id }, c), true)
    const o = await place(f.slug, ribeye(f), pickup)
    expect(o.status).toBe('confirmed')

    // Now a block over the order fails: orders and blocks cannot overlap.
    await expectFail(asRole('authenticated', ownerClaims(owner), (c) =>
      rpc('owner_create_block', { p_tenant: f.tenantId, p_resource_id: f.resources['table-1'], p_starts_at: start,
        p_ends_at: end, p_reason: 'x', p_idempotency_key: key() }, c)), 'resource_busy')
  })
})

describe('reschedule', () => {
  it('moves the occupancy atomically, bumps version and replaces the reminder', async () => {
    const f = await createTenant({ tables: 1 })
    const p1 = await slotAt(f, ribeye(f), 4)
    const o = await place(f.slug, ribeye(f), p1)
    const p2 = new Date(new Date(p1).getTime() + 2 * 3600_000).toISOString()
    const k = key()
    const r = await rpc('reschedule_order_by_token', { p_order_id: o.id, p_token: o.access_token, p_pickup_at: p2, p_idempotency_key: k })
    expect(new Date(r.pickup_at).toISOString()).toBe(new Date(p2).toISOString())
    expect(r.version).toBe(2)
    const jobs = await q<{ status: string; order_version: number }>(
      `select status, order_version from public.notification_jobs where order_id = $1 and kind = 'pickup_reminder' order by id`, [o.id])
    expect(jobs.map((j) => j.status)).toEqual(['skipped', 'skipped'])  // preview tenant: never sent
    // Replay with the same key returns the same result without moving again.
    const again = await rpc('reschedule_order_by_token', { p_order_id: o.id, p_token: o.access_token, p_pickup_at: p2, p_idempotency_key: k })
    expect(again.replayed).toBe(true)
    expect(again.version).toBe(2)
    await expectFail(rpc('reschedule_order_by_token', { p_order_id: o.id, p_token: o.access_token,
      p_pickup_at: p1, p_idempotency_key: k }), 'idempotency_conflict')
  })

  it('a failed reschedule keeps the original order and occupancy intact', async () => {
    const f = await createTenant({ tables: 1 })
    const p1 = await slotAt(f, ribeye(f), 4)
    const p2 = new Date(new Date(p1).getTime() + 2 * 3600_000).toISOString()
    const mine = await place(f.slug, ribeye(f), p1, 1)
    await place(f.slug, ribeye(f), p2, 2)  // someone else holds p2
    const before = await one('select period::text from public.resource_occupancies where order_id = $1', [mine.id])

    await expectFail(rpc('reschedule_order_by_token', { p_order_id: mine.id, p_token: mine.access_token,
      p_pickup_at: p2, p_idempotency_key: key() }), 'slot_taken')

    const after = await one('select period::text from public.resource_occupancies where order_id = $1', [mine.id])
    expect(after).toEqual(before)
    const order = await one<{ pickup_at: Date; version: number }>('select pickup_at, version from public.orders where id = $1', [mine.id])
    expect(order.pickup_at.toISOString()).toBe(new Date(p1).toISOString())
    expect(order.version).toBe(1)
  })

  it('can shift into a range that overlaps its own old range', async () => {
    const f = await createTenant({ tables: 1 })
    const p1 = await slotAt(f, ribeye(f), 4)
    const o = await place(f.slug, ribeye(f), p1)
    const p2 = new Date(new Date(p1).getTime() + 30 * 60_000).toISOString()  // 30 min later, prep is 35 min
    const r = await rpc('reschedule_order_by_token', { p_order_id: o.id, p_token: o.access_token, p_pickup_at: p2, p_idempotency_key: key() })
    expect(r.version).toBe(2)
  })

  it('cancel frees the resource and is idempotent', async () => {
    const f = await createTenant({ tables: 1 })
    const p1 = await slotAt(f, ribeye(f), 4)
    const o = await place(f.slug, ribeye(f), p1)
    const c1 = await rpc('cancel_order_by_token', { p_order_id: o.id, p_token: o.access_token, p_reason: 'планы' })
    expect(c1.status).toBe('cancelled')
    const c2 = await rpc('cancel_order_by_token', { p_order_id: o.id, p_token: o.access_token, p_reason: 'планы' })
    expect(c2.replayed).toBe(true)
    expect((await q('select 1 from public.resource_occupancies where order_id = $1', [o.id])).length).toBe(0)
    const again = await place(f.slug, ribeye(f), p1, 2)
    expect(again.status).toBe('confirmed')
  })

  it('enforces the change deadline for customers but not for the owner', async () => {
    const f = await createTenant({ tables: 1, cancelNotice: 600 })
    const owner = await createOwner(f.tenantId)
    const p1 = await slotAt(f, ribeye(f), 1)
    if (new Date(p1).getTime() - Date.now() > 600 * 60_000) return  // deadline not reached in this time window
    const o = await place(f.slug, ribeye(f), p1)
    await expectFail(rpc('cancel_order_by_token', { p_order_id: o.id, p_token: o.access_token, p_reason: '' }), 'too_late_to_change')
    const r = await asRole('authenticated', ownerClaims(owner), (c) =>
      rpc('owner_cancel_order', { p_tenant: f.tenantId, p_order_id: o.id, p_reason: 'по звонку' }, c), true)
    expect(r.status).toBe('cancelled')
  })
})

describe('idempotency and access tokens', () => {
  it('replays the same order and the same token for a retried request', async () => {
    const f = await createTenant()
    const pickup = await slotAt(f, ribeye(f))
    const k = key()
    const a = await place(f.slug, ribeye(f), pickup, 1, k)
    const b = await place(f.slug, ribeye(f), pickup, 1, k)
    expect(b.id).toBe(a.id)
    expect(b.access_token).toBe(a.access_token)
    expect(b.replayed).toBe(true)
    expect(a.access_token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect((await q('select 1 from public.orders where tenant_id = $1', [f.tenantId])).length).toBe(1)
    // Only the hash is stored.
    const stored = await one<{ h: Buffer }>('select access_token_hash h from public.orders where id = $1', [a.id])
    expect(stored.h.toString('base64url')).not.toBe(a.access_token)
    expect(stored.h.length).toBe(32)
  })

  it('rejects the same key with a different payload', async () => {
    const f = await createTenant()
    const pickup = await slotAt(f, ribeye(f))
    const k = key()
    await place(f.slug, ribeye(f), pickup, 1, k)
    await expectFail(place(f.slug, ribeye(f, 2), pickup, 1, k), 'idempotency_conflict')
  })

  it('concurrent retries with one key create one order', async () => {
    const f = await createTenant()
    const pickup = await slotAt(f, ribeye(f))
    const k = key()
    const res = await Promise.all([1, 2, 3].map(() => place(f.slug, ribeye(f), pickup, 1, k)))
    expect(new Set(res.map((r) => r.id)).size).toBe(1)
    expect(new Set(res.map((r) => r.access_token)).size).toBe(1)
  })

  it('a wrong token reveals nothing', async () => {
    const f = await createTenant()
    const o = await place(f.slug, ribeye(f), await slotAt(f, ribeye(f)))
    await expectFail(rpc('get_order_by_token', { p_order_id: o.id, p_token: 'x'.repeat(43) }), 'order_not_found')
    const ok = await rpc('get_order_by_token', { p_order_id: o.id, p_token: o.access_token })
    expect(ok.number).toBe(o.number)
  })
})

describe('validation', () => {
  it('rejects off-grid pickup, bad quantities and unknown products', async () => {
    const f = await createTenant()
    const pickup = await slotAt(f, ribeye(f))
    const offGrid = new Date(new Date(pickup).getTime() + 7 * 60_000).toISOString()
    await expectFail(place(f.slug, ribeye(f), offGrid), 'slot_unavailable')
    await expectFail(place(f.slug, ribeye(f, 0.3), pickup), 'invalid_quantity')
    await expectFail(place(f.slug, [{ product_id: f.products.ribeye, quantity: 1 }, { product_id: f.products.ribeye, quantity: 1 }], pickup), 'duplicate_product')
    await expectFail(place(f.slug, [{ product_id: '00000000-0000-0000-0000-000000000000', quantity: 1 }], pickup), 'product_unavailable')
    await expectFail(rpc('place_order', { p_slug: f.slug, p_items: ribeye(f), p_pickup_at: pickup,
      p_customer: { name: 'A', phone: '123' }, p_idempotency_key: key() }), 'invalid_name')
  })

  it('cannot order products of another tenant', async () => {
    const a = await createTenant()
    const b = await createTenant()
    const pickup = await slotAt(a, ribeye(a))
    await expectFail(place(a.slug, ribeye(b), pickup), 'product_unavailable')
  })
})
