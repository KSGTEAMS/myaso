// npm run tenant:publish -- <slug> [--live] [--demo] [--invite-owner [--owner-password <pw>]] [--local] [--deploy]
//
//  1. validates tenants/<slug> (schema, references, images);
//  2. upserts the tenant into the database (publish_tenant): catalog,
//     resources, hours; existing orders and owner-uploaded photos are kept;
//  3. optionally attaches the owner (no public sign-up exists);
//  4. preview: optional flagged demo data; live: server-side readiness check,
//     then demo data is purged;
//  5. records the tenant in tenants/registry.json so the next site build
//     emits its shell next to every previously published shop;
//  6. --deploy builds the static site and uploads it to Cloudflare Pages.
import { spawnSync } from 'node:child_process'
import { arg, resolveTarget, rpc, serviceClient } from './lib/env.ts'
import { buildPayload, mediaPaths, readRegistry, upsertRegistry, validateTenant } from './lib/tenant.ts'
import { inviteOwner } from './owner-invite.ts'

async function main() {
  const slug = process.argv.slice(2).find((a) => !a.startsWith('--') && !process.argv[process.argv.indexOf(a) - 1]?.startsWith('--owner-password'))
  if (!slug) { console.error('usage: npm run tenant:publish -- <slug> [--live] [--demo] [--invite-owner] [--deploy] [--local]'); process.exit(1) }
  const live = process.argv.includes('--live')
  const { business, problems } = await validateTenant(slug)
  if (!business || problems.length) {
    for (const p of problems) console.error(`  ${p.path}: ${p.message}`)
    throw new Error(`tenants/${slug} is not valid; run npm run tenant:validate -- ${slug}`)
  }
  const target = resolveTarget()
  const sb = serviceClient(target)
  const payload = buildPayload(business, mediaPaths(slug, business))
  console.log(`→ publishing ${slug} to ${target.local ? 'local stack' : target.url} (${live ? 'live' : 'preview'})`)

  const first = await rpc(sb, 'publish_tenant', { p_payload: payload, p_mode: 'preview' })
  console.log(`  tenant ${first.tenant_id} · config v${first.config_version}${first.changed ? ' (changed)' : ' (unchanged)'} · status ${first.status}`)

  if (process.argv.includes('--invite-owner')) {
    if (!business.owner?.email) throw new Error('business.json has no owner.email')
    const r = await inviteOwner({ slug, email: business.owner.email, password: arg('owner-password') })
    console.log(`  owner ${r.email}${r.password ? ` · password: ${r.password}` : ' · existing account'}`)
  }

  let status = first.status as 'preview' | 'live'
  if (live) {
    const res = await rpc(sb, 'publish_tenant', { p_payload: payload, p_mode: 'live' })
    status = res.status
    console.log(`  live ✓ · demo orders purged: ${res.demo_orders_purged}`)
  } else if (process.argv.includes('--demo') && status === 'preview') {
    const d = await rpc(sb, 'generate_demo_orders', { p_slug: slug, p_future: 6, p_past: 10 })
    console.log(d.reason ? `  demo data: ${d.reason}` : `  demo data: ${d.created ?? 0} upcoming, ${d.past ?? 0} past (flagged is_demo, never notifies)`)
  }

  const readiness = await rpc(sb, 'tenant_readiness', { p_slug: slug })
  if (!readiness.ready) console.log(`  not ready for live yet: ${readiness.problems.join(', ')}`)

  const prev = readRegistry().find((e) => e.slug === slug)
  upsertRegistry({ slug, status, config_hash: payload.config_hash, config_version: first.config_version, published_at: new Date().toISOString() })
  console.log(`  registry: ${prev ? 'updated' : 'added'} (${readRegistry().length} shops in total)`)

  if (process.argv.includes('--deploy')) {
    const build = spawnSync('npm', ['run', 'build'], { stdio: 'inherit' })
    if (build.status !== 0) throw new Error('build failed')
    if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_PAGES_PROJECT) {
      console.log('  built dist/. Set CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_PAGES_PROJECT to upload, or push to the Git branch connected to Pages.')
    } else {
      const dep = spawnSync('npx', ['--yes', 'wrangler@4', 'pages', 'deploy', 'dist', '--project-name', process.env.CLOUDFLARE_PAGES_PROJECT], { stdio: 'inherit' })
      if (dep.status !== 0) throw new Error('wrangler deploy failed')
    }
  } else {
    console.log('  next: npm run build (or push) so the site includes /s/' + slug + '/, then npm run tenant:verify -- ' + slug)
  }
}

main().catch((e) => { console.error(`✗ ${e.message}`); process.exit(1) })
