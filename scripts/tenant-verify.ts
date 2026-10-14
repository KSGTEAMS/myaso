// npm run tenant:verify -- <slug> [--site <url>] [--local]
// Verifies a published shop end to end: database state matches business.json,
// readiness, public API answers, and the deployed site serves this shop's own
// shell, manifest (id/start_url/scope), icons, startup images and deep links.
import sharp from 'sharp'
import { arg, resolveTarget, rpc, serviceClient } from './lib/env.ts'
import { STARTUP_SIZES, buildPayload, mediaPaths, readRegistry, validateTenant } from './lib/tenant.ts'

type Check = { name: string; ok: boolean; detail?: string }

async function main() {
  const slug = process.argv.slice(2).find((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--site')
  if (!slug) { console.error('usage: npm run tenant:verify -- <slug> [--site https://shop.example] [--local]'); process.exit(1) }
  const site = (arg('site') ?? process.env.PUBLIC_APP_URL ?? 'http://127.0.0.1:4173').replace(/\/$/, '')
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail })

  const { business, problems } = await validateTenant(slug)
  check('business.json valid', !!business && problems.length === 0, problems.map((p) => `${p.path}: ${p.message}`).join('; '))
  if (!business) return report(checks)
  const payload = buildPayload(business, mediaPaths(slug, business))
  check('listed in tenants/registry.json', readRegistry().some((e) => e.slug === slug))

  // ---- database
  const target = resolveTarget()
  const sb = serviceClient(target)
  const { data: t } = await sb.from('tenants').select('id,status,config_hash,timezone').eq('slug', slug).maybeSingle()
  check('tenant row exists', !!t)
  if (t) {
    check('database config matches business.json', t.config_hash === payload.config_hash, `db ${t.config_hash} vs local ${payload.config_hash}`)
    check('timezone', t.timezone === business.timezone)
    const { count } = await sb.from('products').select('id', { count: 'exact', head: true }).eq('tenant_id', t.id).eq('is_active', true)
    check('active products', count === business.products.filter((p) => p.active).length, `${count}`)
    const readiness = await rpc(sb, 'tenant_readiness', { p_slug: slug })
    check(`readiness (${t.status})`, t.status !== 'live' || readiness.ready, readiness.problems.join(', '))
    if (t.status === 'live') {
      const { count: demo } = await sb.from('orders').select('id', { count: 'exact', head: true }).eq('tenant_id', t.id).eq('is_demo', true)
      check('live has no demo orders', demo === 0)
    }
    const first = business.products.find((p) => p.active)!
    const { data: prod } = await sb.from('products').select('id').eq('tenant_id', t.id).eq('key', first.key).single()
    const r = await fetch(`${target.url}/functions/v1/public-api`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'slots', slug, items: [{ product_id: prod!.id, quantity: first.min_qty }] }) })
    const body = await r.json() as { slots?: unknown[] }
    check('public API returns pickup slots', r.ok && Array.isArray(body.slots), `${r.status}, ${body.slots?.length ?? 0} slots`)
  }

  // ---- static site
  const get = async (p: string) => { try { return await fetch(`${site}${p}`) } catch { return null } }
  const meta = (html: string, name: string) => html.match(new RegExp(`<meta name="${name}" content="([^"]*)"`))?.[1]
  for (const [p, kind] of [[`/s/${slug}/`, 'client'], [`/s/${slug}/orders/00000000-0000-4000-8000-000000000000`, 'client'], [`/s/${slug}/cart`, 'client'],
    [`/s/${slug}/owner/`, 'owner'], [`/s/${slug}/owner/orders/x`, 'owner']] as const) {
    const r = await get(p)
    const html = r?.ok ? await r.text() : ''
    check(`shell ${p}`, meta(html, 'tenant-slug') === slug && meta(html, 'tenant-kind') === kind,
      r ? `${r.status} slug=${meta(html, 'tenant-slug')} kind=${meta(html, 'tenant-kind')}` : `site unreachable: ${site}`)
    if (p === `/s/${slug}/`) {
      check('apple-touch-icon + startup images linked', html.includes('apple-touch-icon') && (html.match(/apple-touch-startup-image/g)?.length ?? 0) === STARTUP_SIZES.length)
    }
  }
  for (const [file, scope] of [['manifest', `/s/${slug}/`], ['owner', `/s/${slug}/owner/`]] as const) {
    const r = await get(`/t/${slug}/${file}.webmanifest`)
    const m = r?.ok ? await r.json() as any : null
    check(`${file}.webmanifest id/scope/start_url`, m?.id === scope && m?.scope === scope && m?.start_url?.startsWith(scope) && m?.display === 'standalone')
    for (const icon of m?.icons ?? []) {
      const ir = await get(icon.src)
      const meta2 = ir?.ok ? await sharp(Buffer.from(await ir.arrayBuffer())).metadata() : null
      check(`icon ${icon.src} (${icon.purpose})`, `${meta2?.width}x${meta2?.height}` === icon.sizes)
    }
  }
  for (const p of [`/t/${slug}/icons/apple-touch-icon.png`, `/t/${slug}/startup/1179x2556.png`, '/sw.js']) {
    const r = await get(p)
    check(`asset ${p}`, !!r?.ok)
  }
  const hero = payload.profile.hero_image?.replace(/^static:/, '')
  if (hero) check('hero image', !!(await get(`${hero}-800.webp`))?.ok)
  report(checks)
}

function report(checks: Check[]) {
  for (const c of checks) console.log(`${c.ok ? '✓' : '✗'} ${c.name}${!c.ok && c.detail ? ` — ${c.detail}` : ''}`)
  const failed = checks.filter((c) => !c.ok).length
  console.log(failed ? `\n${failed} check(s) failed` : `\nall ${checks.length} checks passed`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e.message); process.exit(1) })
