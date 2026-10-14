// Customer API through the `public-api` Edge Function (rate limited; the
// server computes prices, durations and resources).
import { env } from '@/lib/env'
import { ApiError } from '@/lib/errors'
import { functionsUrl } from '@/lib/supabase'
import type { CartLine, Order, SlotsResponse } from './types'

async function post<T>(body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  let res: Response
  try {
    res = await fetch(functionsUrl('public-api'), {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', apikey: env.anonKey, Authorization: `Bearer ${env.anonKey}` },
      body: JSON.stringify(body),
    })
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw new ApiError('network')
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(data.error ?? 'internal_error', res.status, data.detail)
  return data as T
}

export const publicApi = {
  slots: (slug: string, items: CartLine[], from?: string, to?: string, signal?: AbortSignal) =>
    post<SlotsResponse>({ action: 'slots', slug, items, from, to }, signal),
  place: (input: { slug: string; items: CartLine[]; pickup_at: string; idempotency_key: string; customer: { name: string; phone: string; email?: string; note?: string } }) =>
    post<Order>({ action: 'place', ...input }),
  get: (orderId: string, token: string) => post<Order>({ action: 'get', order_id: orderId, token }),
  reschedule: (orderId: string, token: string, pickupAt: string, key: string) =>
    post<Order>({ action: 'reschedule', order_id: orderId, token, pickup_at: pickupAt, idempotency_key: key }),
  cancel: (orderId: string, token: string, reason?: string) => post<Order>({ action: 'cancel', order_id: orderId, token, reason }),
  push: (orderId: string, token: string, subscription: PushSubscriptionJSON) =>
    post<{ subscribed: boolean }>({ action: 'push', order_id: orderId, token, subscription }),
  icsUrl: (orderId: string, token: string) => `${functionsUrl('public-api')}?ics=1&order_id=${orderId}&token=${encodeURIComponent(token)}`,
}
