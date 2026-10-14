import { afterAll, describe, expect, it } from 'vitest'
import { asRole, createOwner, createTenant, customer, expectFail, key, ownerClaims, pool, q, ribeye, rpc, slotAt } from './helpers.ts'

afterAll(() => pool.end())

async function seedOrder() {
  const f = await createTenant()
  const owner = await createOwner(f.tenantId)
  const o = await rpc('place_order', { p_slug: f.slug, p_items: ribeye(f), p_pickup_at: await slotAt(f, ribeye(f)),
    p_customer: customer(1), p_idempotency_key: key() })
  return { f, owner, o }
}

describe('anon role', () => {
  it('reads the public catalog of preview/live tenants only', async () => {
    const { f } = await seedOrder()
    await q(`insert into public.tenants (slug, name, timezone) values ($1, 'Draft', 'UTC')`, [`draft-${f.slug}`])
    const rows = await asRole('anon', {}, async (c) => ({
      tenants: (await c.query('select slug from public.tenants')).rows.map((r) => r.slug),
      products: (await c.query('select key, price_cents from public.products where tenant_id = $1', [f.tenantId])).rowCount,
    }))
    expect(rows.tenants).toContain(f.slug)
    expect(rows.tenants).not.toContain(`draft-${f.slug}`)
    expect(rows.products).toBe(3)
  })

  it.each([
    'select * from public.orders',
    'select * from public.order_items',
    'select * from public.payments',
    'select * from public.push_subscriptions',
    'select * from public.notification_jobs',
    'select * from public.order_requests',
    'select * from public.resource_occupancies',
    'select * from public.tenant_members',
    'select * from private.app_settings',
    'select * from private.rate_limit_counters',
  ])('is denied: %s', async (sql) => {
    await expect(asRole('anon', {}, (c) => c.query(sql))).rejects.toThrow(/permission denied/)
  })

  it.each([
    `select public.place_order('x', '[]', now(), '{}', gen_random_uuid())`,
    `select public.get_pickup_slots('x', '[]', null, null)`,
    `select public.get_order_by_token(gen_random_uuid(), 'x')`,
    `select public.publish_tenant('{}', 'preview')`,
    `select public.claim_notification_jobs('w', 1, 1)`,
    `select public.rate_limit_hit('b', 1, 1)`,
    `select public.llm_budget_reserve(gen_random_uuid(), 1, 1, 1)`,
    `select public.owner_tenants()`,
    `select private.derive_token(gen_random_uuid(), gen_random_uuid())`,
  ])('cannot execute server-only function: %s', async (sql) => {
    await expect(asRole('anon', {}, (c) => c.query(sql))).rejects.toThrow(/permission denied/)
  })

  it('cannot write the catalog', async () => {
    const { f } = await seedOrder()
    await expect(asRole('anon', {}, (c) => c.query('update public.products set price_cents = 1 where tenant_id = $1', [f.tenantId])))
      .rejects.toThrow(/permission denied/)
  })
})

describe('authenticated owners', () => {
  it('see only their own tenant orders and never the token hash', async () => {
    const a = await seedOrder()
    const b = await seedOrder()
    const visible = await asRole('authenticated', ownerClaims(a.owner), async (c) =>
      (await c.query('select id, tenant_id from public.orders')).rows)
    expect(visible.map((r) => r.id)).toEqual([a.o.id])
    await expect(asRole('authenticated', ownerClaims(a.owner), (c) => c.query('select access_token_hash from public.orders')))
      .rejects.toThrow(/permission denied/)
    // Directly asking for tenant B's data returns nothing through RLS...
    const leaked = await asRole('authenticated', ownerClaims(a.owner), async (c) =>
      (await c.query('select * from public.order_items where tenant_id = $1', [b.f.tenantId])).rowCount)
    expect(leaked).toBe(0)
    // ...and owner RPCs refuse a tenant the user is not a member of.
    await expectFail(asRole('authenticated', ownerClaims(a.owner), (c) =>
      rpc('owner_stats', { p_tenant: b.f.tenantId, p_period: 'today' }, c)), 'forbidden')
    await expectFail(asRole('authenticated', ownerClaims(a.owner), (c) =>
      rpc('owner_cancel_order', { p_tenant: b.f.tenantId, p_order_id: b.o.id, p_reason: '' }, c)), 'forbidden')
    // Cross-tenant id smuggling: own tenant id + foreign order id.
    await expectFail(asRole('authenticated', ownerClaims(a.owner), (c) =>
      rpc('owner_cancel_order', { p_tenant: a.f.tenantId, p_order_id: b.o.id, p_reason: '' }, c)), 'order_not_found')
  })

  it('a signed-in user without membership gets nothing', async () => {
    const a = await seedOrder()
    const stranger = '00000000-0000-4000-8000-000000000001'
    const t = await asRole('authenticated', ownerClaims(stranger), (c) => rpc('owner_tenants', {}, c))
    expect(t).toEqual([])
    await expectFail(asRole('authenticated', ownerClaims(stranger), (c) =>
      rpc('owner_schedule', { p_tenant: a.f.tenantId, p_from: '2026-01-01', p_to: '2026-01-02' }, c)), 'forbidden')
  })

  it('cannot insert orders or members directly', async () => {
    const a = await seedOrder()
    await expect(asRole('authenticated', ownerClaims(a.owner), (c) =>
      c.query(`insert into public.tenant_members (tenant_id, user_id) values ($1, $2)`, [a.f.tenantId, a.owner])))
      .rejects.toThrow(/permission denied/)
    await expect(asRole('authenticated', ownerClaims(a.owner), (c) =>
      c.query(`update public.orders set subtotal_cents = 0`))).rejects.toThrow(/permission denied/)
  })
})

describe('composite tenant foreign keys', () => {
  it('reject a row that mixes tenants', async () => {
    const a = await createTenant()
    const b = await createTenant()
    await expect(q(`insert into public.prep_profile_resources (tenant_id, prep_profile_id, resource_id)
      values ($1, (select id from public.prep_profiles where tenant_id = $1 limit 1), $2)`, [a.tenantId, b.resources['table-1']]))
      .rejects.toThrow(/foreign key/)
  })
})
