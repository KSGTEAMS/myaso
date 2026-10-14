// Outbox worker. Invoked every minute by Supabase Cron (pg_cron + pg_net)
// with a shared secret. Claims due jobs under a lease, sends Web Push to
// each target, and records the outcome. Retries use exponential backoff.
import { call, type RpcClient } from '../_shared/db.ts'
import { json, type Env } from '../_shared/http.ts'
import { notificationMessage, type OutboxJob } from '../_shared/messages.ts'
import { sendPush, type VapidKeys } from '../_shared/webpush.ts'

export interface DispatchDeps { env: Env; service: RpcClient; fetchImpl?: typeof fetch; workerId?: string }

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let r = 0
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return r === 0
}

export function createDispatchHandler({ env, service, fetchImpl = fetch, workerId }: DispatchDeps) {
  return async (req: Request): Promise<Response> => {
    const secret = env('CRON_SECRET')
    if (!secret || !timingSafeEqual(req.headers.get('x-cron-secret') ?? '', secret)) {
      return json({ error: 'forbidden' }, 403)
    }
    const vapid: VapidKeys | null = env('VAPID_PUBLIC_KEY') && env('VAPID_PRIVATE_KEY')
      ? { publicKey: env('VAPID_PUBLIC_KEY')!, privateKey: env('VAPID_PRIVATE_KEY')!, subject: env('VAPID_SUBJECT') ?? 'mailto:admin@example.com' }
      : null
    const worker = workerId ?? `dispatch-${crypto.randomUUID().slice(0, 8)}`
    const appUrl = env('PUBLIC_APP_URL') ?? 'http://localhost:5173'
    const jobs = await call<OutboxJob[]>(service, 'claim_notification_jobs', { p_worker: worker, p_limit: 50, p_lease_seconds: 120 })
    const summary = { claimed: jobs.length, sent: 0, skipped: 0, failed: 0 }

    for (const job of jobs) {
      if (!vapid) {
        await call(service, 'fail_notification_job', { p_job_id: job.id, p_worker: worker, p_error: 'VAPID keys not configured', p_retry_seconds: 300 })
        summary.failed++
        continue
      }
      const message = notificationMessage(job, appUrl)
      let delivered = 0
      let transient = 0
      for (const target of job.targets) {
        try {
          const r = await sendPush(target, message, vapid, { ttl: 6 * 3600, topic: `o${job.order_id ?? job.id}`, urgency: 'high' }, fetchImpl)
          await call(service, 'push_delivery_result', { p_subscription_id: target.id, p_ok: r.ok, p_gone: r.gone })
          if (r.ok) delivered++
          else if (!r.gone && (r.status === 429 || r.status >= 500)) transient++
        } catch {
          transient++
        }
      }
      if (transient > 0 && delivered === 0) {
        await call(service, 'fail_notification_job', { p_job_id: job.id, p_worker: worker, p_error: `transient failures: ${transient}`, p_retry_seconds: 60 })
        summary.failed++
      } else {
        await call(service, 'complete_notification_job', { p_job_id: job.id, p_worker: worker, p_delivered: delivered })
        if (delivered > 0) summary.sent++
        else summary.skipped++
      }
    }
    return json(summary)
  }
}
