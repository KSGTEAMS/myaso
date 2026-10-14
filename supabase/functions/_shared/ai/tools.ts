import { z } from 'zod'
import { call } from '../db.ts'
import type { Scope, ToolContext, ToolResult } from './types.ts'

const Period = z.enum(['today', 'yesterday', 'tomorrow', 'week', 'last7', 'month', 'custom'])
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export interface ToolDef<A extends z.ZodType = z.ZodType> {
  name: string
  scope: Scope
  description: string
  args: A
  run: (args: z.infer<A>, ctx: ToolContext) => Promise<unknown>
}

function tool<A extends z.ZodType>(t: ToolDef<A>): ToolDef<A> { return t }

async function catalog(ctx: ToolContext) {
  return call<any>(ctx.service, 'public_catalog', { p_slug: ctx.tenant.slug })
}

function money(cents: number) { return Math.round(cents) / 100 }

function slimOrder(o: any, withCustomer: boolean) {
  return {
    number: o.number, status: o.status, pickup_at: o.pickup_at,
    items: o.items.map((i: any) => `${i.name} ${i.quantity} ${i.unit}`),
    estimated_total: money(o.subtotal_cents), final_amount: o.final_amount_cents == null ? null : money(o.final_amount_cents),
    paid: money(o.paid_cents), is_demo: o.is_demo,
    ...(withCustomer ? { customer: o.customer_name, phone: o.customer_phone, note: o.note || undefined } : {}),
  }
}

function ownerClient(ctx: ToolContext) {
  if (ctx.scope !== 'owner' || !ctx.owner) throw new Error('owner_scope_required')
  return ctx.owner
}

export const TOOLS = [
  tool({
    name: 'catalog', scope: 'client',
    description: 'Ассортимент магазина: товары, цены за кг или штуку, время подготовки. Можно фильтровать по словам.',
    args: z.object({ query: z.string().max(60).optional() }),
    async run({ query }, ctx) {
      const c = await catalog(ctx)
      const q = query?.toLowerCase().trim()
      const products = (c.products as any[])
        .filter((p) => !q || `${p.name} ${p.category} ${p.description}`.toLowerCase().includes(q))
        .slice(0, 25)
        .map((p) => ({ key: p.key, name: p.name, category: p.category, price: money(p.price_cents),
                       unit: p.unit, min_qty: p.min_qty, prep: p.prep_name, prep_minutes: p.prep_base_minutes }))
      return { currency: c.tenant.currency, products }
    },
  }),
  tool({
    name: 'pickup_slots', scope: 'client',
    description: 'Ближайшее свободное время выдачи для набора товаров (ключи товаров из catalog и количество).',
    args: z.object({
      items: z.array(z.object({ product_key: z.string().max(60), quantity: z.number().positive().max(100) })).min(1).max(10),
      date: isoDate.optional(),
    }),
    async run({ items, date }, ctx) {
      const c = await catalog(ctx)
      const byKey = new Map((c.products as any[]).map((p) => [p.key, p]))
      const lines = items.map((i) => {
        const p = byKey.get(i.product_key)
        if (!p) throw new Error(`unknown product ${i.product_key}`)
        const step = Number(p.qty_step)
        const qty = Math.min(Number(p.max_qty), Math.max(Number(p.min_qty), Math.round(i.quantity / step) * step))
        return { product_id: p.id, quantity: Number(qty.toFixed(3)) }
      })
      const res = await call<any>(ctx.service, 'get_pickup_slots', { p_slug: ctx.tenant.slug, p_items: lines, p_from: date ?? null, p_to: null })
      return { timezone: res.timezone, first_slots: (res.slots as any[]).slice(0, 8).map((s) => `${s.local_date} ${s.local_time}`),
               total_slots: res.slots.length, estimated_total: money(res.subtotal_cents), preparation: res.groups }
    },
  }),
  tool({
    name: 'shop_info', scope: 'client',
    description: 'Адрес самовывоза, телефон, часы выдачи и особые дни.',
    args: z.object({}),
    async run(_a, ctx) {
      const c = await catalog(ctx)
      return { name: c.tenant.name, timezone: c.tenant.timezone, contacts: c.tenant.profile?.contacts ?? {},
               hours: c.hours, exceptions: c.exceptions, payment_note: c.tenant.profile?.payment_note }
    },
  }),
  tool({
    name: 'my_order', scope: 'client',
    description: 'Статус и время выдачи заказа покупателя, открытого по его личной ссылке.',
    args: z.object({}),
    async run(_a, ctx) {
      if (!ctx.orderAccess) return { available: false, reason: 'Откройте ссылку на ваш заказ, чтобы я мог его найти.' }
      const o = await call<any>(ctx.service, 'get_order_by_token', { p_order_id: ctx.orderAccess.orderId, p_token: ctx.orderAccess.token })
      return { available: true, can_change_until: o.change_deadline, can_change: o.can_change, ...slimOrder(o, false) }
    },
  }),
  tool({
    name: 'schedule', scope: 'owner',
    description: 'Заказы к выдаче и блокировки ресурсов за период (по часовому поясу магазина).',
    args: z.object({ period: Period.default('today'), from: isoDate.optional(), to: isoDate.optional() }),
    async run({ period, from, to }, ctx) {
      const owner = ownerClient(ctx)
      const b = await call<any>(owner, 'owner_period_bounds', { p_tenant: ctx.tenant.id, p_period: period, p_from: from ?? null, p_to: to ?? null })
      const s = await call<any>(owner, 'owner_schedule', { p_tenant: ctx.tenant.id, p_from: b.from_date, p_to: b.to_date })
      const orders = (s.orders as any[]).filter((o) => o.status !== 'cancelled')
      return { bounds: b, total: orders.length, cancelled: s.orders.length - orders.length,
               orders: orders.slice(0, 30).map((o) => slimOrder(o, true)),
               blocks: (s.blocks as any[]).map((x) => ({ resource: x.resource_name, from: x.starts_at, to: x.ends_at, reason: x.reason })) }
    },
  }),
  tool({
    name: 'stats', scope: 'owner',
    description: 'Статистика за период: визиты за заказами, выданные заказы, полученные платежи, ожидаемые выдачи (не выручка).',
    args: z.object({ period: Period.default('today'), from: isoDate.optional(), to: isoDate.optional() }),
    async run({ period, from, to }, ctx) {
      const s = await call<any>(ownerClient(ctx), 'owner_stats', { p_tenant: ctx.tenant.id, p_period: period, p_from: from ?? null, p_to: to ?? null })
      return {
        bounds: s.bounds, visits: s.visits,
        completed_orders: { count: s.completed_orders.count, value: money(s.completed_orders.value_cents) },
        payments_received: { count: s.payments_received.count, net: money(s.payments_received.net_cents), refunds: money(s.payments_received.refunds_cents) },
        expected_pickups_not_revenue: { count: s.expected_pickups.count, value: money(s.expected_pickups.value_cents) },
        cancelled: s.cancelled, no_show: s.no_show, currency: s.currency,
      }
    },
  }),
  tool({
    name: 'find_orders', scope: 'owner',
    description: 'Найти заказы по номеру, телефону или имени покупателя.',
    args: z.object({ query: z.string().min(1).max(60) }),
    async run({ query }, ctx) {
      const rows = await call<any[]>(ownerClient(ctx), 'owner_find_orders', { p_tenant: ctx.tenant.id, p_query: query, p_limit: 10 })
      return { found: rows.length, orders: rows.map((o) => slimOrder(o, true)) }
    },
  }),
] as const

export type ToolName = (typeof TOOLS)[number]['name']

export function toolsForScope(scope: Scope): ToolDef[] {
  // Owner sessions may also use client tools (catalog, shop info); a client
  // session never sees owner tools.
  return (TOOLS as readonly ToolDef[]).filter((t) => t.scope === 'client' || scope === 'owner')
    .filter((t) => !(scope === 'owner' && t.name === 'my_order'))
}

/** Run a tool by name with permission and argument checks. Never throws. */
export async function runTool(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
  const def = toolsForScope(ctx.scope).find((t) => t.name === name)
  if (!def) return { ok: false, error: `tool_not_allowed:${name}` }
  const parsed = def.args.safeParse(rawArgs ?? {})
  if (!parsed.success) return { ok: false, error: `invalid_arguments:${parsed.error.issues[0]?.path.join('.') ?? ''}` }
  try {
    return { ok: true, data: await def.run(parsed.data, ctx) }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** OpenAI-compatible function schema. */
export function toolSchemas(scope: Scope) {
  return toolsForScope(scope).map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: z.toJSONSchema(t.args) },
  }))
}
