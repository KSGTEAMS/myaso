import { afterAll, describe, expect, it } from 'vitest'
import { createOwner, createTenant, customer, key, one, pool, q, ribeye, rpc, slotAt } from './helpers.ts'

afterAll(() => pool.end())

async function liveTenantWithOrder(hoursAhead = 6) {
  const f = await createTenant({ status: 'live', tables: 2 })
  const pickup = await slotAt(f, ribeye(f), hoursAhead)
  const o = await rpc('place_order', { p_slug: f.slug, p_items: ribeye(f), p_pickup_at: pickup,
    p_customer: customer(1), p_idempotency_key: key() })
  return { f, o, pickup }
}

const claim = (worker: string, limit = 50, lease = 60) =>
  rpc<any[]>('claim_notification_jobs', { p_worker: worker, p_limit: limit, p_lease_seconds: lease })

const mine = (jobs: any[], tenantId: string) => jobs.filter((j) => j.tenant_id === tenantId)

describe('notification outbox', () => {
  it('creates deduplicated jobs and leases them to one worker at a time', async () => {
    const { f, o } = await liveTenantWithOrder()
    const jobs = await q<{ kind: string; status: string; dedupe_key: string }>(
      'select kind, status, dedupe_key from public.notification_jobs where order_id = $1 order by id', [o.id])
    expect(jobs.map((j) => [j.kind, j.status])).toEqual([['order_created', 'pending'], ['pickup_reminder', 'pending']])
    // Re-enqueueing the same logical event is a no-op.
    await q(`select private.enqueue_job($1, $2, 'order_created', 'owner', now(), $3, 1)`, [f.tenantId, o.id, jobs[0]!.dedupe_key])
    expect((await q('select 1 from public.notification_jobs where order_id = $1', [o.id])).length).toBe(2)

    const [w1, w2] = await Promise.all([claim('w1'), claim('w2')])
    const a = mine(w1, f.tenantId).map((j) => j.id)
    const b = mine(w2, f.tenantId).map((j) => j.id)
    expect(a.length + b.length).toBe(1) // only order_created is due now; reminder is in the future
    expect(a.filter((id) => b.includes(id))).toEqual([])
    const claimed = [...mine(w1, f.tenantId), ...mine(w2, f.tenantId)][0]
    expect(claimed.kind).toBe('order_created')
    expect(claimed.order.number).toBe(o.number)

    // Nobody else can claim it while the lease is valid.
    expect(mine(await claim('w3'), f.tenantId)).toEqual([])
    const worker = a.length ? 'w1' : 'w2'
    expect(await rpc('complete_notification_job', { p_job_id: claimed.id, p_worker: 'w3', p_delivered: 1 })).toBeNull()
    expect(await rpc('complete_notification_job', { p_job_id: claimed.id, p_worker: worker, p_delivered: 1 })).toBe(true)
    expect((await one<{ status: string }>('select status from public.notification_jobs where id = $1', [claimed.id])).status).toBe('sent')
  })

  it('re-claims a job whose lease expired and backs off on failure', async () => {
    const { f, o } = await liveTenantWithOrder()
    const first = mine(await claim('crashy', 50, 1), f.tenantId)[0]
    expect(first).toBeDefined()
    await q(`update public.notification_jobs set lease_until = now() - interval '1 second' where id = $1`, [first.id])
    const again = mine(await claim('healthy'), f.tenantId)[0]
    expect(again.id).toBe(first.id)
    expect(again.attempts).toBe(2)
    expect(await rpc('fail_notification_job', { p_job_id: again.id, p_worker: 'healthy', p_error: 'push 500', p_retry_seconds: 30 })).toBe(true)
    const row = await one<{ status: string; run_at: Date }>('select status, run_at from public.notification_jobs where id = $1', [again.id])
    expect(row.status).toBe('pending')
    expect(row.run_at.getTime()).toBeGreaterThan(Date.now() + 50_000) // 30s * 2^(attempts-1)
    expect(o.id).toBeTruthy()
  })

  it('withdraws reminders for the old time after a reschedule and after cancel', async () => {
    const { f, o, pickup } = await liveTenantWithOrder(8)
    const slots = (await rpc('get_pickup_slots', { p_slug: f.slug, p_items: ribeye(f), p_from: null, p_to: null })).slots
    const other = slots.find((s: { pickup_at: string }) => new Date(s.pickup_at).getTime() > new Date(pickup).getTime() + 3600_000).pickup_at
    await rpc('reschedule_order_by_token', { p_order_id: o.id, p_token: o.access_token, p_pickup_at: other, p_idempotency_key: key() })
    const reminders = await q<{ status: string; order_version: number; run_at: Date }>(
      `select status, order_version, run_at from public.notification_jobs where order_id = $1 and kind = 'pickup_reminder' order by id`, [o.id])
    expect(reminders.map((r) => [r.status, r.order_version])).toEqual([['cancelled', 1], ['pending', 2]])
    expect(reminders[1]!.run_at.getTime()).toBe(new Date(other).getTime() - 2 * 3600_000)
    const notices = await q<{ kind: string }>(`select kind from public.notification_jobs where order_id = $1 and audience = 'owner' order by id`, [o.id])
    expect(notices.map((n) => n.kind)).toEqual(['order_created', 'order_rescheduled'])

    // A stale job that slipped through is cancelled at claim time.
    await q(`update public.notification_jobs set status = 'pending', run_at = now() where order_id = $1 and order_version = 1 and kind = 'pickup_reminder'`, [o.id])
    const claimed = mine(await claim('w'), f.tenantId)
    expect(claimed.some((j) => j.kind === 'pickup_reminder')).toBe(false)

    await rpc('cancel_order_by_token', { p_order_id: o.id, p_token: o.access_token, p_reason: '' })
    const pending = await q(`select 1 from public.notification_jobs where order_id = $1 and kind = 'pickup_reminder' and status = 'pending'`, [o.id])
    expect(pending.length).toBe(0)
  })

  it('preview tenants and demo orders never produce sendable jobs', async () => {
    const f = await createTenant() // preview
    const o = await rpc('place_order', { p_slug: f.slug, p_items: ribeye(f), p_pickup_at: await slotAt(f, ribeye(f)),
      p_customer: customer(1), p_idempotency_key: key() })
    expect(o.is_demo).toBe(true)
    const jobs = await q<{ status: string }>('select status from public.notification_jobs where order_id = $1', [o.id])
    expect(jobs.length).toBeGreaterThan(0)
    expect(jobs.every((j) => j.status === 'skipped')).toBe(true)
  })

  it('returns owner and client push targets per audience', async () => {
    const { f, o } = await liveTenantWithOrder()
    const owner = (await q<{ user_id: string }>('select user_id from public.tenant_members where tenant_id = $1', [f.tenantId]))[0]!.user_id
    await q(`insert into public.push_subscriptions (tenant_id, audience, user_id, endpoint, p256dh, auth)
             values ($1, 'owner', $2, 'https://push.example.test/owner', 'k', 'a')`, [f.tenantId, owner])
    await rpc('register_client_push', { p_order_id: o.id, p_token: o.access_token,
      p_subscription: { endpoint: 'https://push.example.test/client', keys: { p256dh: 'k2', auth: 'a2' } } })
    const job = mine(await claim('w'), f.tenantId)[0]
    expect(job.audience).toBe('owner')
    expect(job.targets.map((t: { endpoint: string }) => t.endpoint)).toEqual(['https://push.example.test/owner'])
    expect(await createOwner(f.tenantId)).toBeTruthy()
  })
})
