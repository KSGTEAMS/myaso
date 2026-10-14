// Public catalog: read straight from PostgREST with the anon key. RLS lets
// anon read only non-personal catalog data of preview/live shops.
import { publicDb } from '@/lib/supabase'
import { ApiError } from '@/lib/errors'
import type { Shop, Tenant, PrepProfile } from './types'

export async function fetchShop(slug: string): Promise<Shop> {
  const t = await publicDb.from('tenants')
    .select('id,slug,name,status,timezone,currency,pickup_step_minutes,min_notice_minutes,horizon_days,cancel_notice_minutes,max_order_lines,profile')
    .eq('slug', slug).maybeSingle()
  if (t.error) throw new ApiError('network', 0, t.error.message)
  if (!t.data) throw new ApiError('tenant_not_found', 404)
  const tenant = t.data as Tenant
  const [cats, prods, preps, hours, ex] = await Promise.all([
    publicDb.from('product_categories').select('id,key,name,sort_order').eq('tenant_id', tenant.id).eq('is_active', true).order('sort_order'),
    publicDb.from('products').select('id,key,category_id,prep_profile_id,name,description,unit,price_cents,qty_step,min_qty,max_qty,badges,image_path,image_source,is_active,sort_order')
      .eq('tenant_id', tenant.id).eq('is_active', true).order('sort_order'),
    publicDb.from('prep_profiles').select('id,key,name,base_minutes,per_kg_minutes,per_unit_minutes,buffer_minutes').eq('tenant_id', tenant.id),
    publicDb.from('working_hours').select('weekday,opens_at,closes_at').eq('tenant_id', tenant.id).order('weekday').order('opens_at'),
    publicDb.from('schedule_exceptions').select('day,is_closed,opens_at,closes_at,note').eq('tenant_id', tenant.id).order('day'),
  ])
  for (const r of [cats, prods, preps, hours, ex]) if (r.error) throw new ApiError('network', 0, r.error.message)
  return {
    tenant,
    categories: cats.data ?? [],
    products: (prods.data ?? []).map((p) => ({ ...p, qty_step: Number(p.qty_step), min_qty: Number(p.min_qty), max_qty: Number(p.max_qty), price_cents: Number(p.price_cents) })),
    prep: Object.fromEntries((preps.data ?? []).map((p) => [p.id, { ...p, per_kg_minutes: Number(p.per_kg_minutes), per_unit_minutes: Number(p.per_unit_minutes) } as PrepProfile])),
    hours: hours.data ?? [],
    exceptions: ex.data ?? [],
  }
}
