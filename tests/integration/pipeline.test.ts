import { afterAll, describe, expect, it } from 'vitest'
import { createOwner, createTenant, customer, expectFail, key, one, pool, q, ribeye, rpc, slotAt } from './helpers.ts'

afterAll(() => pool.end())

describe('publishing', () => {
  it('republishing keeps orders and owner-uploaded photos and deactivates removed products', async () => {
    const f = await createTenant()
    const o = await rpc('place_order', { p_slug: f.slug, p_items: ribeye(f), p_pickup_at: await slotAt(f, ribeye(f)),
      p_customer: customer(1), p_idempotency_key: key() })
    await q(`update public.products set image_path = $2, image_source = 'owner' where id = $1`,
      [f.products.ribeye, `${f.tenantId}/owner/ribeye-real.jpg`])

    const next = { ...f.payload, config_hash: key(), name: 'Renamed',
      products: f.payload.products.filter((p) => p.key !== 'mince').map((p) => ({ ...p, image_path: 'pipeline/new.jpg' })) }
    const res = await rpc('publish_tenant', { p_payload: next, p_mode: 'preview' })
    expect(res.config_version).toBe(2)
    expect(res.changed).toBe(true)

    const rib = await one<{ image_path: string; image_source: string }>('select image_path, image_source from public.products where id = $1', [f.products.ribeye])
    expect(rib).toEqual({ image_path: `${f.tenantId}/owner/ribeye-real.jpg`, image_source: 'owner' })
    const brisket = await one<{ image_path: string }>('select image_path from public.products where id = $1', [f.products['brisket-smoked']])
    expect(brisket.image_path).toBe('pipeline/new.jpg')
    const mince = await one<{ is_active: boolean }>('select is_active from public.products where id = $1', [f.products.mince])
    expect(mince.is_active).toBe(false)
    expect((await q('select 1 from public.orders where id = $1', [o.id])).length).toBe(1)

    // Same hash again: version does not move.
    const same = await rpc('publish_tenant', { p_payload: next, p_mode: 'preview' })
    expect(same.config_version).toBe(2)
    expect(same.changed).toBe(false)
  })

  it('a second tenant never replaces the first', async () => {
    const a = await createTenant()
    const b = await createTenant()
    const slugs = (await q<{ slug: string }>('select slug from public.tenants where slug = any($1)', [[a.slug, b.slug]])).map((r) => r.slug)
    expect(slugs.sort()).toEqual([a.slug, b.slug].sort())
  })

  it('live requires readiness, then purges demo data', async () => {
    const f = await createTenant()
    const demo = await rpc('generate_demo_orders', { p_slug: f.slug, p_future: 3, p_past: 4 })
    expect(demo.past).toBe(4)
    expect((await q('select 1 from public.orders where tenant_id = $1 and not is_demo', [f.tenantId])).length).toBe(0)

    const ready = await rpc('tenant_readiness', { p_slug: f.slug })
    expect(ready.ready).toBe(false)
    expect(ready.problems).toContain('no_owner')
    await expectFail(rpc('publish_tenant', { p_payload: f.payload, p_mode: 'live' }), 'not_ready_for_live')

    await createOwner(f.tenantId)
    const live = await rpc('publish_tenant', { p_payload: f.payload, p_mode: 'live' })
    expect(live.status).toBe('live')
    expect(live.demo_orders_purged).toBeGreaterThanOrEqual(4)
    expect((await q('select 1 from public.orders where tenant_id = $1', [f.tenantId])).length).toBe(0)
    expect((await q('select 1 from public.payments where tenant_id = $1', [f.tenantId])).length).toBe(0)
    await expectFail(rpc('generate_demo_orders', { p_slug: f.slug }), 'demo_only_in_preview')

    // Live orders are real: not demo, notifications pending.
    const o = await rpc('place_order', { p_slug: f.slug, p_items: ribeye(f), p_pickup_at: await slotAt(f, ribeye(f)),
      p_customer: customer(1), p_idempotency_key: key() })
    expect(o.is_demo).toBe(false)
  })
})

describe('shared atomic counters', () => {
  it('rate limit counts every hit exactly once under concurrency', async () => {
    const bucket = `test:${key()}`
    const res = await Promise.all(Array.from({ length: 25 }, () => rpc('rate_limit_hit', { p_bucket: bucket, p_limit: 10, p_window_seconds: 60 })))
    expect(res.filter((r) => r.allowed).length).toBe(10)
    expect(Math.max(...res.map((r) => r.hits))).toBe(25)
  })

  it('LLM budget never exceeds the cap, even with parallel reservations', async () => {
    const f = await createTenant()
    const res = await Promise.all(Array.from({ length: 12 }, () =>
      rpc<boolean>('llm_budget_reserve', { p_tenant: f.tenantId, p_tokens: 1000, p_tenant_daily: 5000, p_global_daily: 100_000_000 })))
    expect(res.filter(Boolean).length).toBe(5)
    const used = await one<{ tokens: string }>(`select tokens from private.llm_usage where scope = $1`, [`tenant:${f.tenantId}`])
    expect(Number(used.tokens)).toBe(5000)
    await rpc('llm_budget_commit', { p_tenant: f.tenantId, p_reserved: 1000, p_actual: 400 })
    const after = await one<{ tokens: string }>(`select tokens from private.llm_usage where scope = $1`, [`tenant:${f.tenantId}`])
    expect(Number(after.tokens)).toBe(4400)
  })
})
