// Tenant pipeline core: business.json + images -> validated payload for the
// database, processed media, icons, manifests and per-tenant HTML shells.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { BusinessSchema, WEEKDAYS, crossCheck, onAccent, type Business, type Problem } from '../../shared/business-schema.ts'
import { iconSvg } from './art.ts'

export const ROOT = path.resolve(import.meta.dirname, '../..')
export const TENANTS_DIR = path.join(ROOT, 'tenants')
export const REGISTRY = path.join(TENANTS_DIR, 'registry.json')

export interface RegistryEntry { slug: string; status: 'preview' | 'live'; config_hash?: string; config_version?: number; published_at?: string }

export function readRegistry(): RegistryEntry[] {
  if (!existsSync(REGISTRY)) return []
  return (JSON.parse(readFileSync(REGISTRY, 'utf8')) as { tenants: RegistryEntry[] }).tenants
}

export function writeRegistry(entries: RegistryEntry[]) {
  const sorted = [...entries].sort((a, b) => a.slug.localeCompare(b.slug))
  writeFileSync(REGISTRY, `${JSON.stringify({ tenants: sorted }, null, 2)}\n`)
}

/** Add or update one tenant; never removes others. */
export function upsertRegistry(entry: RegistryEntry) {
  const all = readRegistry().filter((e) => e.slug !== entry.slug)
  writeRegistry([...all, entry])
}

export function tenantDir(slug: string) { return path.join(TENANTS_DIR, slug) }

export function loadBusiness(slug: string): { business?: Business; problems: Problem[]; raw?: unknown } {
  const file = path.join(tenantDir(slug), 'business.json')
  if (!existsSync(file)) return { problems: [{ path: file, message: 'business.json not found' }] }
  let raw: unknown
  try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch (e) {
    return { problems: [{ path: 'business.json', message: `invalid JSON: ${(e as Error).message}` }] }
  }
  const parsed = BusinessSchema.safeParse(raw)
  if (!parsed.success) {
    return { raw, problems: parsed.error.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message })) }
  }
  const problems = crossCheck(parsed.data)
  if (parsed.data.slug !== slug) problems.push({ path: 'slug', message: `slug "${parsed.data.slug}" must match folder "${slug}"` })
  return { business: parsed.data, problems, raw }
}

const MIN_SIZE = { hero: [1200, 700], product: [600, 450], icon: [512, 512] } as const

export async function validateImages(slug: string, b: Business): Promise<Problem[]> {
  const out: Problem[] = []
  const check = async (rel: string, kind: keyof typeof MIN_SIZE, at: string) => {
    const file = path.join(tenantDir(slug), 'images', rel)
    if (!existsSync(file)) { out.push({ path: at, message: `image not found: images/${rel}` }); return }
    try {
      const m = await sharp(file).metadata()
      const [w, h] = MIN_SIZE[kind]
      if ((m.width ?? 0) < w || (m.height ?? 0) < h) out.push({ path: at, message: `images/${rel} is ${m.width}x${m.height}, needs at least ${w}x${h}` })
      if (kind === 'icon' && m.width !== m.height) out.push({ path: at, message: 'icon must be square' })
    } catch {
      out.push({ path: at, message: `images/${rel} is not a readable image` })
    }
  }
  await check(b.brand.hero_image, 'hero', 'brand.hero_image')
  if (b.brand.icon_image) await check(b.brand.icon_image, 'icon', 'brand.icon_image')
  if (!b.brand.icon_image && !b.brand.icon_letter) out.push({ path: 'brand', message: 'set icon_image or icon_letter' })
  for (const [i, p] of b.products.entries()) if (p.image) await check(p.image, 'product', `products[${i}].image`)
  return out
}

export async function validateTenant(slug: string): Promise<{ business?: Business; problems: Problem[] }> {
  const { business, problems } = loadBusiness(slug)
  if (!business) return { problems }
  return { business, problems: [...problems, ...(await validateImages(slug, business))] }
}

const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')

export interface MediaEntry { source: string; base: string; widths: number[] }

/** Content-addressed responsive WebP renditions under <out>/t/<slug>/media. */
export async function processMedia(slug: string, b: Business, outDir: string): Promise<Map<string, string>> {
  const media = path.join(outDir, 't', slug, 'media')
  mkdirSync(media, { recursive: true })
  const map = new Map<string, string>()
  const jobs: Array<[string, number[]]> = [[b.brand.hero_image, [800, 1600]], ...b.products.filter((p) => p.image).map((p) => [p.image!, [480, 960]] as [string, number[]])]
  for (const [rel, widths] of jobs) {
    if (map.has(rel)) continue
    const src = readFileSync(path.join(tenantDir(slug), 'images', rel))
    const name = `${path.basename(rel, path.extname(rel))}-${sha(Buffer.concat([src, Buffer.from(widths.join(','))])).slice(0, 10)}`
    for (const w of widths) {
      const file = path.join(media, `${name}-${w}.webp`)
      if (!existsSync(file)) await sharp(src).resize({ width: w, height: Math.round(w * 0.75), fit: 'cover' }).webp({ quality: 78 }).toFile(file)
    }
    map.set(rel, `static:/t/${slug}/media/${name}`)
  }
  return map
}

/** Media paths without touching disk (same hashing), for seed generation. */
export function mediaPaths(slug: string, b: Business): Map<string, string> {
  const map = new Map<string, string>()
  const jobs: Array<[string, number[]]> = [[b.brand.hero_image, [800, 1600]], ...b.products.filter((p) => p.image).map((p) => [p.image!, [480, 960]] as [string, number[]])]
  for (const [rel, widths] of jobs) {
    const src = readFileSync(path.join(tenantDir(slug), 'images', rel))
    map.set(rel, `static:/t/${slug}/media/${path.basename(rel, path.extname(rel))}-${sha(Buffer.concat([src, Buffer.from(widths.join(','))])).slice(0, 10)}`)
  }
  return map
}

const ISO_DAY: Record<(typeof WEEKDAYS)[number], number> = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 }

/** DB payload for public.publish_tenant. config_hash covers config and images. */
export function buildPayload(b: Business, media: Map<string, string>) {
  const payload = {
    slug: b.slug,
    name: b.name,
    timezone: b.timezone,
    currency: b.currency,
    locale: b.locale,
    ordering: {
      pickup_step_minutes: b.ordering.pickup_step_minutes,
      min_notice_minutes: b.ordering.min_notice_minutes,
      horizon_days: b.ordering.horizon_days,
      cancel_notice_minutes: b.ordering.cancel_notice_minutes,
      max_order_lines: b.ordering.max_order_lines,
    },
    profile: {
      short_name: b.short_name,
      accent: b.brand.accent,
      on_accent: onAccent(b.brand.accent),
      background: b.brand.background,
      tagline: b.brand.tagline,
      description: b.brand.description,
      hero_image: media.get(b.brand.hero_image) ?? null,
      contacts: b.contacts,
      payment_note: b.ordering.payment_note,
      ai: b.ai,
    },
    hours: WEEKDAYS.flatMap((d) => b.hours[d].map(([opens, closes]) => ({ weekday: ISO_DAY[d], opens, closes }))),
    exceptions: b.exceptions.flatMap((e) => e.closed
      ? [{ day: e.date, is_closed: true, note: e.note }]
      : e.hours.map(([opens, closes]) => ({ day: e.date, is_closed: false, opens, closes, note: e.note }))),
    resources: b.resources,
    prep_profiles: b.prep_profiles,
    categories: b.categories,
    products: b.products.map((p) => ({
      key: p.key, category: p.category, prep: p.prep, name: p.name, description: p.description, unit: p.unit,
      price_cents: Math.round(p.price * 100), qty_step: p.qty_step, min_qty: p.min_qty, max_qty: p.max_qty,
      badges: p.badges, image_path: p.image ? media.get(p.image) ?? null : null, is_active: p.active,
    })),
  }
  return { ...payload, config_hash: sha(JSON.stringify(payload)).slice(0, 32) }
}

// ---------------------------------------------------------------- PWA assets

export const STARTUP_SIZES: Array<{ w: number; h: number; dw: number; dh: number; dpr: number }> = [
  { w: 1290, h: 2796, dw: 430, dh: 932, dpr: 3 },
  { w: 1179, h: 2556, dw: 393, dh: 852, dpr: 3 },
  { w: 1284, h: 2778, dw: 428, dh: 926, dpr: 3 },
  { w: 1170, h: 2532, dw: 390, dh: 844, dpr: 3 },
  { w: 1125, h: 2436, dw: 375, dh: 812, dpr: 3 },
  { w: 1242, h: 2688, dw: 414, dh: 896, dpr: 3 },
  { w: 828, h: 1792, dw: 414, dh: 896, dpr: 2 },
  { w: 750, h: 1334, dw: 375, dh: 667, dpr: 2 },
  { w: 1536, h: 2048, dw: 768, dh: 1024, dpr: 2 },
]

async function iconBase(slug: string, b: Business, kind: 'client' | 'owner'): Promise<Buffer> {
  if (b.brand.icon_image) {
    const img = sharp(path.join(tenantDir(slug), 'images', b.brand.icon_image)).resize(1024, 1024, { fit: 'cover' })
    if (kind === 'client') return img.png().toBuffer()
    // Owner app icon: same artwork with a ring so both apps are distinguishable.
    const ring = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><circle cx="512" cy="512" r="470" fill="none" stroke="${b.brand.accent}" stroke-width="56"/></svg>`)
    return img.composite([{ input: ring }]).png().toBuffer()
  }
  const letter = b.brand.icon_letter ?? b.short_name.slice(0, 1)
  const svg = kind === 'client'
    ? iconSvg(letter, b.brand.accent, b.brand.background, onAccent(b.brand.accent))
    : iconSvg(letter, b.brand.background, b.brand.accent, b.brand.accent)
        .replace('<circle', `<circle stroke="${b.brand.accent}" stroke-width="40"`)
  return sharp(Buffer.from(svg)).png().toBuffer()
}

export async function writePwaAssets(slug: string, b: Business, outDir: string) {
  const dir = path.join(outDir, 't', slug)
  mkdirSync(path.join(dir, 'icons'), { recursive: true })
  mkdirSync(path.join(dir, 'startup'), { recursive: true })
  for (const kind of ['client', 'owner'] as const) {
    const base = await iconBase(slug, b, kind)
    const p = kind === 'client' ? '' : 'owner-'
    await sharp(base).resize(192, 192).png().toFile(path.join(dir, 'icons', `${p}icon-192.png`))
    await sharp(base).resize(512, 512).png().toFile(path.join(dir, 'icons', `${p}icon-512.png`))
    // Maskable: artwork inside the 80% safe zone on a full-bleed background.
    const inner = await sharp(base).resize(410, 410).png().toBuffer()
    await sharp({ create: { width: 512, height: 512, channels: 4, background: b.brand.background } })
      .composite([{ input: inner, gravity: 'center' }]).png().toFile(path.join(dir, 'icons', `${p}maskable-512.png`))
    // Apple ignores transparency and maskable; give it an opaque 180px icon.
    await sharp(base).resize(180, 180).flatten({ background: b.brand.background }).png().toFile(path.join(dir, 'icons', `${p}apple-touch-icon.png`))
  }
  await sharp(await iconBase(slug, b, 'client')).resize(32, 32).png().toFile(path.join(dir, 'icons', 'favicon-32.png'))
  const logo = await sharp(await iconBase(slug, b, 'client')).resize(240, 240).png().toBuffer()
  for (const s of STARTUP_SIZES) {
    const file = path.join(dir, 'startup', `${s.w}x${s.h}.png`)
    if (existsSync(file)) continue
    await sharp({ create: { width: s.w, height: s.h, channels: 3, background: b.brand.background } })
      .composite([{ input: logo, gravity: 'center' }]).png({ compressionLevel: 9 }).toFile(file)
  }
}

export function manifest(b: Business, kind: 'client' | 'owner') {
  const scope = kind === 'client' ? `/s/${b.slug}/` : `/s/${b.slug}/owner/`
  const p = kind === 'client' ? '' : 'owner-'
  return {
    id: scope,
    name: kind === 'client' ? b.name : `${b.short_name} · кабинет`,
    short_name: kind === 'client' ? b.short_name : `${b.short_name} · кабинет`.slice(0, 20),
    description: kind === 'client' ? b.brand.tagline : 'Заказы, выдача и статистика магазина',
    lang: 'ru',
    dir: 'ltr',
    start_url: `${scope}?source=pwa`,
    scope,
    display: 'standalone',
    orientation: 'portrait',
    background_color: b.brand.background,
    theme_color: b.brand.background,
    icons: [
      { src: `/t/${b.slug}/icons/${p}icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: `/t/${b.slug}/icons/${p}icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: `/t/${b.slug}/icons/${p}maskable-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Per-tenant head; replaces the <!--tenant-head--> marker in index.html. */
export function shellHead(b: Business, kind: 'client' | 'owner', heroUrl?: string): string {
  const t = `/t/${b.slug}`
  const p = kind === 'client' ? '' : 'owner-'
  const title = kind === 'client' ? `${b.name} — заказ на самовывоз` : `Кабинет · ${b.name}`
  return [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(kind === 'client' ? b.brand.description : 'Кабинет владельца магазина')}" />`,
    kind === 'owner' ? '<meta name="robots" content="noindex, nofollow" />' : '',
    `<meta name="tenant-slug" content="${esc(b.slug)}" />`,
    `<meta name="tenant-kind" content="${kind}" />`,
    `<meta name="tenant-accent" content="${esc(b.brand.accent)}" />`,
    `<meta name="tenant-background" content="${esc(b.brand.background)}" />`,
    `<meta name="tenant-name" content="${esc(b.name)}" />`,
    `<meta name="theme-color" content="${esc(b.brand.background)}" />`,
    `<link rel="manifest" href="${t}/${kind === 'client' ? 'manifest' : 'owner'}.webmanifest" />`,
    `<link rel="icon" type="image/png" sizes="32x32" href="${t}/icons/favicon-32.png" />`,
    `<link rel="apple-touch-icon" href="${t}/icons/${p}apple-touch-icon.png" />`,
    '<meta name="mobile-web-app-capable" content="yes" />',
    '<meta name="apple-mobile-web-app-capable" content="yes" />',
    '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />',
    `<meta name="apple-mobile-web-app-title" content="${esc(kind === 'client' ? b.short_name : `${b.short_name} кабинет`)}" />`,
    ...STARTUP_SIZES.map((s) => `<link rel="apple-touch-startup-image" media="(device-width: ${s.dw}px) and (device-height: ${s.dh}px) and (-webkit-device-pixel-ratio: ${s.dpr}) and (orientation: portrait)" href="${t}/startup/${s.w}x${s.h}.png" />`),
    `<meta property="og:title" content="${esc(b.name)}" />`,
    `<meta property="og:description" content="${esc(b.brand.tagline)}" />`,
    heroUrl ? `<meta property="og:image" content="${esc(heroUrl)}" />` : '',
    heroUrl && kind === 'client' ? `<link rel="preload" as="image" href="${esc(heroUrl)}" />` : '',
  ].filter(Boolean).join('\n    ')
}

export function renderShell(template: string, b: Business, kind: 'client' | 'owner', heroUrl?: string): string {
  if (!template.includes('<!--tenant-head-->')) throw new Error('index.html is missing the <!--tenant-head--> marker')
  return template.replace(/<title>[^<]*<\/title>\s*/, '').replace('<!--tenant-head-->', shellHead(b, kind, heroUrl))
}

/** Static per-tenant files under <outDir>/t/<slug>/: media, icons, manifests. */
export async function buildTenantAssets(slug: string, outDir: string) {
  const { business, problems } = await validateTenant(slug)
  if (!business || problems.length) throw new Error(`${slug}: ${problems.map((p) => `${p.path}: ${p.message}`).join('; ')}`)
  const media = await processMedia(slug, business, outDir)
  await writePwaAssets(slug, business, outDir)
  const t = path.join(outDir, 't', slug)
  writeFileSync(path.join(t, 'manifest.webmanifest'), JSON.stringify(manifest(business, 'client'), null, 2))
  writeFileSync(path.join(t, 'owner.webmanifest'), JSON.stringify(manifest(business, 'owner'), null, 2))
  const hero = media.get(business.brand.hero_image)?.replace(/^static:/, '')
  return { business, media, heroUrl: hero ? `${hero}-800.webp` : undefined }
}

/** Write all static tenant files (assets + shells) into outDir. */
export async function buildTenantSite(slug: string, outDir: string, template: string) {
  const { business, media, heroUrl } = await buildTenantAssets(slug, outDir)
  mkdirSync(path.join(outDir, 's', slug, 'owner'), { recursive: true })
  writeFileSync(path.join(outDir, 's', slug, 'index.html'), renderShell(template, business, 'client', heroUrl))
  writeFileSync(path.join(outDir, 's', slug, 'owner', 'index.html'), renderShell(template, business, 'owner', heroUrl))
  return { business, media }
}

export function listTenantFolders(): string[] {
  return readdirSync(TENANTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('_')).map((d) => d.name)
}
