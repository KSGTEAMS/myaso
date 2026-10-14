export type Unit = 'kg' | 'pcs'
export type OrderStatus = 'confirmed' | 'ready' | 'completed' | 'cancelled' | 'no_show'

export interface TenantProfile {
  short_name?: string
  accent?: string
  on_accent?: string
  background?: string
  tagline?: string
  description?: string
  hero_image?: string | null
  contacts?: { phone?: string; address?: string; map_url?: string; telegram?: string; email?: string }
  payment_note?: string
  ai?: { enabled?: boolean; greeting?: string }
}

export interface Tenant {
  id: string
  slug: string
  name: string
  status: 'preview' | 'live' | 'draft' | 'suspended'
  timezone: string
  currency: string
  pickup_step_minutes: number
  min_notice_minutes: number
  horizon_days: number
  cancel_notice_minutes: number
  max_order_lines: number
  profile: TenantProfile
}

export interface Category { id: string; key: string; name: string; sort_order: number }
export interface PrepProfile { id: string; key: string; name: string; base_minutes: number; per_kg_minutes: number; per_unit_minutes: number; buffer_minutes: number }

export interface Product {
  id: string
  key: string
  category_id: string
  prep_profile_id: string
  name: string
  description: string
  unit: Unit
  price_cents: number
  qty_step: number
  min_qty: number
  max_qty: number
  badges: string[]
  image_path: string | null
  image_source: 'pipeline' | 'owner'
  is_active: boolean
  sort_order: number
}

export interface Hours { weekday: number; opens_at: string; closes_at: string }
export interface ScheduleException { day: string; is_closed: boolean; opens_at: string | null; closes_at: string | null; note: string }

export interface Shop {
  tenant: Tenant
  categories: Category[]
  products: Product[]
  prep: Record<string, PrepProfile>
  hours: Hours[]
  exceptions: ScheduleException[]
}

export interface CartLine { product_id: string; quantity: number }

export interface Slot { pickup_at: string; local_date: string; local_time: string; prep_starts_at: string }
export interface SlotsResponse {
  timezone: string
  from: string
  to: string
  slots: Slot[]
  subtotal_cents: number
  groups: Array<{ prep_profile: string; minutes: number; buffer_minutes: number }>
}

export interface OrderItem { product_id: string; name: string; unit: Unit; unit_price_cents: number; quantity: number; line_total_cents: number }

export interface Order {
  id: string
  number: number
  status: OrderStatus
  pickup_at: string
  customer_name: string
  customer_phone: string
  customer_email: string | null
  note: string
  subtotal_cents: number
  final_amount_cents: number | null
  currency: string
  is_demo: boolean
  source: 'client' | 'owner' | 'demo'
  version: number
  arrived_at: string | null
  ready_at: string | null
  completed_at: string | null
  cancelled_at: string | null
  created_at: string
  change_deadline: string
  can_change: boolean
  tenant: { slug: string; name: string; timezone: string }
  items: OrderItem[]
  preparation: Array<{ resource_id: string; resource_name: string; starts_at: string; ends_at: string }>
  paid_cents: number
  access_token?: string
  replayed?: boolean
}
