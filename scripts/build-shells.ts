// Post-build step: one shared JS/CSS bundle, plus per-tenant static files for
// every shop in tenants/registry.json (shells, manifests, icons, media), and
// the Cloudflare Pages routing/headers. Previously published shops are always
// rebuilt, so adding a shop never removes another.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { ROOT, buildTenantSite, readRegistry } from './lib/tenant.ts'

export const REDIRECTS = `# Deep links of every shop get that shop's shell (SPA routes).
/s/:slug/owner/* /s/:slug/owner/index.html 200
/s/:slug/owner /s/:slug/owner/index.html 200
/s/:slug/* /s/:slug/index.html 200
/s/:slug /s/:slug/index.html 200
`

export const HEADERS = `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
/sw.js
  Cache-Control: no-cache
/assets/*
  Cache-Control: public, max-age=31536000, immutable
/t/*
  Cache-Control: public, max-age=3600
/s/*
  Cache-Control: no-cache
`

export async function buildShells(outDir = path.join(ROOT, 'dist')) {
  const templateFile = path.join(outDir, 'index.html')
  if (!existsSync(templateFile)) throw new Error('dist/index.html missing — run vite build first')
  const template = readFileSync(templateFile, 'utf8')
  const directory = []
  for (const entry of readRegistry()) {
    const { business, media } = await buildTenantSite(entry.slug, outDir, template)
    directory.push({ slug: business.slug, name: business.name, tagline: business.brand.tagline, accent: business.brand.accent,
      status: entry.status, hero: media.get(business.brand.hero_image)?.replace(/^static:/, '') ?? null })
    console.log(`  /s/${entry.slug}/ (${entry.status})`)
  }
  writeFileSync(path.join(outDir, 'tenants.json'), JSON.stringify({ tenants: directory }))
  writeFileSync(path.join(outDir, '_redirects'), REDIRECTS)
  writeFileSync(path.join(outDir, '_headers'), HEADERS)
  return directory
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildShells().then((d) => console.log(`shells for ${d.length} shops written`)).catch((e) => { console.error(e.message); process.exit(1) })
}
