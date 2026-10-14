// Owner cabinet API: PostgREST RPC with the owner's JWT. Every function
// re-checks membership in SQL; the client never decides the tenant on trust.
import type { SupabaseClient } from '@supabase/supabase-js'
import { ApiError } from '@/lib/errors'
import type { Order } from './types'

async function rpc<T>(db: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args)
  if (error) {
    if (error.code === '42501') throw new ApiError('forbidden', 403)
    throw new ApiError(/^[a-z_]+$/.test(error.message) ? error.message : 'internal_error', 0, error.details)
  }
  return data as T
}

export interface OwnerTenant { id: string; slug: string; name: string; status: string; timezone: string; currency: string; role: string }
export interface Bounds { period: string; timezone: string; from_date: string; to_date: string; from_ts: string; to_ts: string }
export interface Stats {
  bounds: Bounds
  currency: string
  visits: number
  completed_orders: { count: number; value_cents: number }
  payments_received: { count: number; net_cents: number; refunds_cents: number }
  scheduled_pickups: number
  expected_pickups: { count: number; value_cents: number }
  cancelled: number
  no_show: number
  resource_load: Array<{ resource_id: string; name: string; busy_minutes: number; period_minutes: number }>
}
export interface Schedule {
  timezone: string
  from_date: string
  to_date: string
  orders: Order[]
  blocks: Array<{ id: string; resource_id: string; resource_name: string; starts_at: string; ends_at: string; reason: string }>
  resources: Array<{ id: string; name: string; kind: string; is_active: boolean }>
  occupancies: Array<{ resource_id: string; starts_at: string; ends_at: string; order_id: string | null; block_id: string | null }>
}
export type Period = 'today' | 'yesterday' | 'tomorrow' | 'week' | 'last7' | 'month' | 'custom'

export function ownerApi(db: SupabaseClient, tenantId: string) {
  const t = { p_tenant: tenantId }
  return {
    bounds: (period: Period, from?: string, to?: string) => rpc<Bounds>(db, 'owner_period_bounds', { ...t, p_period: period, p_from: from ?? null, p_to: to ?? null }),
    stats: (period: Period, from?: string, to?: string) => rpc<Stats>(db, 'owner_stats', { ...t, p_period: period, p_from: from ?? null, p_to: to ?? null }),
    schedule: (from: string, to: string) => rpc<Schedule>(db, 'owner_schedule', { ...t, p_from: from, p_to: to }),
    order: (id: string) => rpc<Order>(db, 'owner_get_order', { ...t, p_order_id: id }),
    find: (q: string) => rpc<Order[]>(db, 'owner_find_orders', { ...t, p_query: q, p_limit: 30 }),
    status: (id: string, action: 'arrived' | 'ready' | 'completed' | 'no_show', finalAmountCents?: number) =>
      rpc<Order>(db, 'owner_update_order_status', { ...t, p_order_id: id, p_action: action, p_final_amount_cents: finalAmountCents ?? null }),
    reschedule: (id: string, pickupAt: string, key: string) => rpc<Order>(db, 'owner_reschedule_order', { ...t, p_order_id: id, p_pickup_at: pickupAt, p_idempotency_key: key }),
    cancel: (id: string, reason: string) => rpc<Order>(db, 'owner_cancel_order', { ...t, p_order_id: id, p_reason: reason }),
    payment: (id: string, amountCents: number, method: string, kind: 'payment' | 'refund', key: string, note = '') =>
      rpc<Order>(db, 'owner_record_payment', { ...t, p_order_id: id, p_amount_cents: amountCents, p_method: method, p_kind: kind, p_idempotency_key: key, p_note: note }),
    createBlock: (resourceId: string, startsAt: string, endsAt: string, reason: string, key: string) =>
      rpc(db, 'owner_create_block', { ...t, p_resource_id: resourceId, p_starts_at: startsAt, p_ends_at: endsAt, p_reason: reason, p_idempotency_key: key }),
    deleteBlock: (id: string) => rpc(db, 'owner_delete_block', { ...t, p_block_id: id }),
    updateProduct: (id: string, patch: { price_cents?: number; is_active?: boolean; image_path?: string }) =>
      rpc(db, 'owner_update_product', { ...t, p_product_id: id, p_price_cents: patch.price_cents ?? null, p_is_active: patch.is_active ?? null, p_image_path: patch.image_path ?? null }),
    createOrder: (items: Array<{ product_id: string; quantity: number }>, pickupAt: string, customer: Record<string, string>, key: string) =>
      rpc<Order>(db, 'owner_create_order', { ...t, p_items: items, p_pickup_at: pickupAt, p_customer: customer, p_idempotency_key: key }),
    registerPush: (sub: PushSubscriptionJSON) => rpc(db, 'owner_register_push', { ...t, p_subscription: sub, p_user_agent: navigator.userAgent }),
    unregisterPush: (endpoint: string) => rpc(db, 'owner_unregister_push', { ...t, p_endpoint: endpoint }),
  }
}

export async function ownerTenants(db: SupabaseClient): Promise<OwnerTenant[]> {
  return rpc<OwnerTenant[]>(db, 'owner_tenants', {})
}
