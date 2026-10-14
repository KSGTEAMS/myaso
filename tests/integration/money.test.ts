import { afterAll, describe, expect, it } from 'vitest'
import { asRole, createOwner, createTenant, customer, expectFail, key, one, ownerClaims, pool, q, ribeye, rpc, slotAt } from './helpers.ts'

afterAll(() => pool.end())

describe('historical prices', () => {
  it('orders keep the snapshot price after the catalog price changes', async () => {
    const f = await createTenant()
    const owner = await createOwner(f.tenantId)
    const pickup = await slotAt(f, ribeye(f))
    const o = await rpc('place_order', { p_slug: f.slug, p_items: ribeye(f, 1.5), p_pickup_at: pickup,
      p_customer: customer(1), p_idempotency_key: key() })
    expect(o.subtotal_cents).toBe(Math.round(289000 * 1.5))

    await asRole('authenticated', ownerClaims(owner), (c) =>
      rpc('owner_update_product', { p_tenant: f.tenantId, p_product_id: f.products.ribeye, p_price_cents: 349000 }, c), true)

    const after = await rpc('get_order_by_token', { p_order_id: o.id, p_token: o.access_token })
    expect(after.items[0].unit_price_cents).toBe(289000)
    expect(after.subtotal_cents).toBe(433500)
    // A reschedule does not re-price either.
    const slots = await rpc('get_pickup_slots', { p_slug: f.slug, p_items: ribeye(f), p_from: null, p_to: null })
    const other = slots.slots.find((s: { pickup_at: string }) => s.pickup_at !== pickup).pickup_at
    const moved = await rpc('reschedule_order_by_token', { p_order_id: o.id, p_token: o.access_token, p_pickup_at: other, p_idempotency_key: key() })
    expect(moved.subtotal_cents).toBe(433500)
    // New orders use the new price.
    const n = await rpc('place_order', { p_slug: f.slug, p_items: ribeye(f, 1), p_pickup_at: other,
      p_customer: customer(2), p_idempotency_key: key() })
    expect(n.subtotal_cents).toBe(349000)
  })

  it('ignores any client-supplied price, total or tenant fields', async () => {
    const f = await createTenant()
    const pickup = await slotAt(f, ribeye(f))
    const o = await rpc('place_order', { p_slug: f.slug,
      p_items: [{ product_id: f.products.ribeye, quantity: 1, price_cents: 1, tenant_id: 'evil', line_total_cents: 1 }],
      p_pickup_at: pickup, p_customer: { ...customer(1), subtotal_cents: 1 }, p_idempotency_key: key() })
    expect(o.subtotal_cents).toBe(289000)
  })
})

describe('payments and statistics', () => {
  it('keeps visits, completed orders, received payments and expected value apart', async () => {
    const f = await createTenant({ tables: 3 })
    const owner = await createOwner(f.tenantId)
    const as = <T>(fn: string, args: Record<string, unknown>) =>
      asRole('authenticated', ownerClaims(owner), (c) => rpc<T>(fn, args, c), true)

    const slots = (await rpc('get_pickup_slots', { p_slug: f.slug, p_items: ribeye(f), p_from: null, p_to: null })).slots
    const mk = (i: number, s: string) => rpc('place_order', { p_slug: f.slug, p_items: ribeye(f, 1), p_pickup_at: s,
      p_customer: customer(i), p_idempotency_key: key() })
    const a = await mk(1, slots[0].pickup_at)
    const b = await mk(2, slots[0].pickup_at)
    const c = await mk(3, slots[1].pickup_at)

    await as('owner_update_order_status', { p_tenant: f.tenantId, p_order_id: a.id, p_action: 'arrived' })
    await as('owner_update_order_status', { p_tenant: f.tenantId, p_order_id: a.id, p_action: 'completed', p_final_amount_cents: 301000 })
    const pk = key()
    await as('owner_record_payment', { p_tenant: f.tenantId, p_order_id: a.id, p_amount_cents: 301000, p_method: 'card', p_kind: 'payment', p_idempotency_key: pk })
    const replay = await as<{ replayed: boolean }>('owner_record_payment', { p_tenant: f.tenantId, p_order_id: a.id, p_amount_cents: 301000, p_method: 'card', p_kind: 'payment', p_idempotency_key: pk })
    expect(replay.replayed).toBe(true)
    await as('owner_record_payment', { p_tenant: f.tenantId, p_order_id: a.id, p_amount_cents: 1000, p_method: 'cash', p_kind: 'refund', p_idempotency_key: key() })
    await expectFail(as('owner_record_payment', { p_tenant: f.tenantId, p_order_id: b.id, p_amount_cents: 5, p_method: 'cash', p_kind: 'refund', p_idempotency_key: key() }), 'refund_exceeds_paid')
    // b: customer arrived but nothing completed or paid yet
    await as('owner_update_order_status', { p_tenant: f.tenantId, p_order_id: b.id, p_action: 'arrived' })

    const s = await as<any>('owner_stats', { p_tenant: f.tenantId, p_period: 'today' })
    expect(s.visits).toBe(2)
    expect(s.completed_orders).toEqual({ count: 1, value_cents: 301000 })
    expect(s.payments_received).toEqual({ count: 1, net_cents: 300000, refunds_cents: 1000 })
    // Pickups still ahead are reported separately and never as revenue.
    const week = await as<any>('owner_stats', { p_tenant: f.tenantId, p_period: 'custom', p_from: s.bounds.from_date,
      p_to: new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10) })
    expect(week.expected_pickups.count).toBe(2) // b and c are still to be picked up
    expect(week.expected_pickups.value_cents).toBe(b.subtotal_cents + c.subtotal_cents)
    expect(Object.keys(week)).not.toContain('revenue')
    expect(s.bounds.timezone).toBe('UTC')
  })

  it('completing an order releases the rest of its occupancy', async () => {
    const f = await createTenant({ tables: 1 })
    const owner = await createOwner(f.tenantId)
    const pickup = await slotAt(f, ribeye(f), 4)
    const o = await rpc('place_order', { p_slug: f.slug, p_items: ribeye(f), p_pickup_at: pickup, p_customer: customer(1), p_idempotency_key: key() })
    await asRole('authenticated', ownerClaims(owner), (c) =>
      rpc('owner_update_order_status', { p_tenant: f.tenantId, p_order_id: o.id, p_action: 'completed' }, c), true)
    const left = await q('select 1 from public.resource_occupancies where order_id = $1', [o.id])
    expect(left.length).toBe(0)  // occupancy was entirely in the future
    const order = await one<{ final_amount_cents: string }>('select final_amount_cents from public.orders where id = $1', [o.id])
    expect(Number(order.final_amount_cents)).toBe(o.subtotal_cents)
  })
})
