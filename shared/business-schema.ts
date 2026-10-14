// Schema of tenants/<slug>/business.json — the single input that re-skins
// the shop. Used by tenant:new / validate / publish / verify and build-shells.
import { z } from 'zod'

const key = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,40}$/, 'lowercase key: a-z, 0-9, -, _')
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM')
const interval = z.tuple([hhmm, hhmm]).refine(([a, b]) => a < b, 'closing time must be after opening time')
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, '#RRGGBB')
const image = z.string().regex(/^[a-zA-Z0-9_./-]+\.(jpe?g|png|webp)$/, 'path inside the tenant images/ folder')

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const

export const BusinessSchema = z.object({
  $schema: z.string().optional(),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/),
  name: z.string().min(1).max(80),
  short_name: z.string().min(1).max(12),
  locale: z.literal('ru-RU').default('ru-RU'),
  timezone: z.string().refine((tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true } catch { return false } }, 'unknown IANA timezone'),
  currency: z.string().regex(/^[A-Z]{3}$/).default('RUB'),
  brand: z.object({
    accent: hex,
    background: hex.default('#0E0E10'),
    tagline: z.string().max(80),
    description: z.string().max(300),
    hero_image: image,
    icon_image: image.optional(),
    icon_letter: z.string().min(1).max(2).optional(),
  }),
  contacts: z.object({
    phone: z.string().regex(/^\+\d{10,15}$/),
    address: z.string().min(5).max(200),
    map_url: z.url().optional(),
    telegram: z.string().max(64).optional(),
    email: z.email().optional(),
  }),
  ordering: z.object({
    pickup_step_minutes: z.number().int().min(5).max(240).default(30),
    min_notice_minutes: z.number().int().min(0).max(10080).default(60),
    horizon_days: z.number().int().min(1).max(90).default(14),
    cancel_notice_minutes: z.number().int().min(0).max(10080).default(120),
    max_order_lines: z.number().int().min(1).max(100).default(20),
    payment_note: z.string().max(200).default('Оплата при получении'),
  }),
  hours: z.object(Object.fromEntries(WEEKDAYS.map((d) => [d, z.array(interval).max(4).default([])])) as Record<(typeof WEEKDAYS)[number], z.ZodDefault<z.ZodArray<typeof interval>>>),
  exceptions: z.array(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    closed: z.boolean().default(false),
    hours: z.array(interval).max(4).default([]),
    note: z.string().max(120).default(''),
  }).refine((e) => e.closed || e.hours.length > 0, 'exception needs closed: true or hours')).default([]),
  resources: z.array(z.object({ key, name: z.string().min(1).max(60), kind: key })).min(1),
  prep_profiles: z.array(z.object({
    key, name: z.string().min(1).max(60),
    base_minutes: z.number().int().min(0).max(20160),
    per_kg_minutes: z.number().min(0).max(600).default(0),
    per_unit_minutes: z.number().min(0).max(600).default(0),
    buffer_minutes: z.number().int().min(0).max(1440).default(0),
    resources: z.array(key).min(1),
  })).min(1),
  categories: z.array(z.object({ key, name: z.string().min(1).max(40) })).min(1),
  products: z.array(z.object({
    key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,60}$/),
    category: key,
    prep: key,
    name: z.string().min(1).max(120),
    description: z.string().max(400).default(''),
    unit: z.enum(['kg', 'pcs']),
    price: z.number().positive().max(10_000_000),
    qty_step: z.number().positive(),
    min_qty: z.number().positive(),
    max_qty: z.number().positive(),
    badges: z.array(z.string().max(24)).max(4).default([]),
    image: image.optional(),
    active: z.boolean().default(true),
  })).min(1),
  ai: z.object({ enabled: z.boolean().default(true), greeting: z.string().max(200).optional() }).default({ enabled: true }),
  owner: z.object({ email: z.email() }).optional(),
})

export type Business = z.infer<typeof BusinessSchema>

export interface Problem { path: string; message: string }

/** Cross-reference and business-rule checks the schema cannot express. */
export function crossCheck(b: Business): Problem[] {
  const out: Problem[] = []
  const dup = (arr: string[], path: string) => {
    const seen = new Set<string>()
    for (const k of arr) { if (seen.has(k)) out.push({ path, message: `duplicate key "${k}"` }); seen.add(k) }
  }
  dup(b.resources.map((r) => r.key), 'resources')
  dup(b.prep_profiles.map((p) => p.key), 'prep_profiles')
  dup(b.categories.map((c) => c.key), 'categories')
  dup(b.products.map((p) => p.key), 'products')
  const res = new Set(b.resources.map((r) => r.key))
  const preps = new Set(b.prep_profiles.map((p) => p.key))
  const cats = new Set(b.categories.map((c) => c.key))
  b.prep_profiles.forEach((p, i) => p.resources.forEach((r) => {
    if (!res.has(r)) out.push({ path: `prep_profiles[${i}].resources`, message: `unknown resource "${r}"` })
  }))
  b.products.forEach((p, i) => {
    const at = `products[${i}] (${p.key})`
    if (!cats.has(p.category)) out.push({ path: at, message: `unknown category "${p.category}"` })
    if (!preps.has(p.prep)) out.push({ path: at, message: `unknown prep profile "${p.prep}"` })
    if (p.max_qty < p.min_qty) out.push({ path: at, message: 'max_qty < min_qty' })
    const ratio = p.min_qty / p.qty_step
    if (Math.abs(ratio - Math.round(ratio)) > 1e-9) out.push({ path: at, message: 'min_qty must be a multiple of qty_step' })
    if (p.unit === 'pcs' && (!Number.isInteger(p.qty_step) || !Number.isInteger(p.min_qty))) out.push({ path: at, message: 'pieces need integer qty_step/min_qty' })
  })
  if (!Object.values(b.hours).some((d) => d.length > 0)) out.push({ path: 'hours', message: 'no pickup hours on any weekday' })
  for (const [day, list] of Object.entries(b.hours)) {
    const sorted = [...list].sort((a, c) => a[0].localeCompare(c[0]))
    for (let i = 1; i < sorted.length; i++) if (sorted[i]![0] < sorted[i - 1]![1]) out.push({ path: `hours.${day}`, message: 'overlapping intervals' })
  }
  const contrast = contrastRatio(b.brand.accent, b.brand.background)
  if (contrast < 3) out.push({ path: 'brand.accent', message: `accent contrast ${contrast.toFixed(2)}:1 against background is below 3:1` })
  return out
}

function luminance(hexColor: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hexColor.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

export function contrastRatio(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (l1! + 0.05) / (l2! + 0.05)
}

/** Black or white text on the accent, whichever contrasts more. */
export function onAccent(accent: string): '#000000' | '#FFFFFF' {
  return contrastRatio(accent, '#000000') >= contrastRatio(accent, '#FFFFFF') ? '#000000' : '#FFFFFF'
}
