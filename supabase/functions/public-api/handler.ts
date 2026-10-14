// Customer API: pickup slots, placing an order, and token-based access to one
// order. The tenant is resolved from the slug in SQL; prices, durations and
// resources are computed in SQL. Every call is rate limited in Postgres.
import { z } from 'zod'
import { call, enforceRateLimits, type RpcClient } from '../_shared/db.ts'
import { HttpError, clientIp, corsHeaders, errorResponse, json, readJson, sha256Hex, type Env } from '../_shared/http.ts'
import { buildIcs } from '../_shared/ics.ts'

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/)
const uuid = z.uuid()
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const items = z.array(z.object({ product_id: uuid, quantity: z.number().positive().max(1000) })).min(1).max(100)
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const instant = z.iso.datetime({ offset: true })

const Actions = z.discriminatedUnion('action', [
  z.object({ action: z.literal('slots'), slug, items, from: isoDate.optional(), to: isoDate.optional() }),
  z.object({
    action: z.literal('place'), slug, items, pickup_at: instant, idempotency_key: uuid,
    customer: z.object({
      name: z.string().max(80), phone: z.string().max(32),
      email: z.string().max(120).optional(), note: z.string().max(500).optional(),
    }),
  }),
  z.object({ action: z.literal('get'), order_id: uuid, token }),
  z.object({ action: z.literal('reschedule'), order_id: uuid, token, pickup_at: instant, idempotency_key: uuid }),
  z.object({ action: z.literal('cancel'), order_id: uuid, token, reason: z.string().max(300).optional() }),
  z.object({
    action: z.literal('push'), order_id: uuid, token,
    subscription: z.object({
      endpoint: z.url().startsWith('https://'),
      keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
    }),
  }),
])

type Action = z.infer<typeof Actions>

const LIMITS: Record<Action['action'], [number, number]> = {
  slots: [90, 60], place: [8, 600], get: [120, 60], reschedule: [10, 600], cancel: [10, 600], push: [10, 600],
}

export interface PublicApiDeps { env: Env; service: RpcClient }

export function createPublicApiHandler({ env, service }: PublicApiDeps) {
  return async (req: Request): Promise<Response> => {
    const cors = corsHeaders(req.headers.get('origin'), env)
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    try {
      const url = new URL(req.url)
      const ipHash = (await sha256Hex(`${env('IP_HASH_SALT') ?? 'local'}:${clientIp(req, env)}`)).slice(0, 32)

      // Calendar file for one order: GET ?ics=1&order_id=..&token=..
      if (req.method === 'GET' && url.searchParams.get('ics') === '1') {
        const parsed = z.object({ order_id: uuid, token }).safeParse(Object.fromEntries(url.searchParams))
        if (!parsed.success) throw new HttpError(400, 'invalid_request')
        await enforceRateLimits(service, [{ bucket: `ip:${ipHash}:ics`, limit: 30, windowSeconds: 600 }])
        const order = await call(service, 'get_order_by_token', { p_order_id: parsed.data.order_id, p_token: parsed.data.token })
        const appUrl = env('PUBLIC_APP_URL') ?? url.origin
        return new Response(buildIcs(order, `${appUrl}/s/${order.tenant.slug}/`), {
          headers: { ...cors, 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-store',
                     'Content-Disposition': `attachment; filename="order-${order.number}.ics"` },
        })
      }
      if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed')

      const parsed = Actions.safeParse(await readJson(req))
      if (!parsed.success) throw new HttpError(400, 'invalid_request', parsed.error.issues[0]?.path.join('.'))
      const a = parsed.data
      const [limit, window] = LIMITS[a.action]
      const rules = [{ bucket: `ip:${ipHash}:${a.action}`, limit, windowSeconds: window }]
      if (a.action === 'place') rules.push({ bucket: `tenant:${a.slug}:place`, limit: 600, windowSeconds: 3600 })
      await enforceRateLimits(service, rules)

      switch (a.action) {
        case 'slots':
          return json(await call(service, 'get_pickup_slots', {
            p_slug: a.slug, p_items: a.items, p_from: a.from ?? null, p_to: a.to ?? null,
          }), 200, cors)
        case 'place':
          return json(await call(service, 'place_order', {
            p_slug: a.slug, p_items: a.items, p_pickup_at: a.pickup_at, p_customer: a.customer,
            p_idempotency_key: a.idempotency_key,
          }), 200, cors)
        case 'get':
          return json(await call(service, 'get_order_by_token', { p_order_id: a.order_id, p_token: a.token }), 200, cors)
        case 'reschedule':
          return json(await call(service, 'reschedule_order_by_token', {
            p_order_id: a.order_id, p_token: a.token, p_pickup_at: a.pickup_at, p_idempotency_key: a.idempotency_key,
          }), 200, cors)
        case 'cancel':
          return json(await call(service, 'cancel_order_by_token', {
            p_order_id: a.order_id, p_token: a.token, p_reason: a.reason ?? '',
          }), 200, cors)
        case 'push':
          return json(await call(service, 'register_client_push', {
            p_order_id: a.order_id, p_token: a.token, p_subscription: a.subscription,
            p_user_agent: req.headers.get('user-agent') ?? '',
          }), 200, cors)
      }
    } catch (e) {
      return errorResponse(e, cors)
    }
  }
}
