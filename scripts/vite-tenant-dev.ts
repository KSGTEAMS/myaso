// Dev-server counterpart of build-shells: serves /s/<slug>/... with that
// shop's shell (meta, manifest, icons) and /t/<slug>/... assets, exactly like
// the Cloudflare Pages build does, so `npm run dev` behaves like production.
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'
import { ROOT, buildTenantAssets, loadBusiness, readRegistry, shellHead } from './lib/tenant.ts'

const DEV_DIR = path.join(ROOT, '.local', 'dev-site')
const TYPES: Record<string, string> = { '.png': 'image/png', '.webp': 'image/webp', '.webmanifest': 'application/manifest+json' }

export function tenantDevPlugin(): Plugin {
  let ready: Promise<unknown> | null = null
  const prepare = () => (ready ??= Promise.all(readRegistry().map((e) => buildTenantAssets(e.slug, DEV_DIR))))
  return {
    name: 'tenant-dev-shells',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://x')
        try {
          if (url.pathname === '/tenants.json') {
            await prepare()
            const tenants = readRegistry().map((e) => {
              const b = loadBusiness(e.slug).business!
              return { slug: e.slug, name: b.name, tagline: b.brand.tagline, accent: b.brand.accent, status: e.status, hero: null }
            })
            res.setHeader('Content-Type', 'application/json')
            return res.end(JSON.stringify({ tenants }))
          }
          if (url.pathname.startsWith('/t/')) {
            await prepare()
            const file = path.join(DEV_DIR, url.pathname)
            if (file.startsWith(DEV_DIR) && existsSync(file) && statSync(file).isFile()) {
              res.setHeader('Content-Type', TYPES[path.extname(file)] ?? 'application/octet-stream')
              return createReadStream(file).pipe(res)
            }
          }
          const m = url.pathname.match(/^\/s\/([a-z0-9-]+)(\/owner)?(\/|$)/)
          if (m && (req.headers.accept ?? '').includes('text/html')) {
            const { business } = loadBusiness(m[1]!)
            if (business) {
              const raw = readFileSync(path.join(ROOT, 'index.html'), 'utf8')
              const html = raw.replace(/<title>[^<]*<\/title>\s*/, '').replace('<!--tenant-head-->', shellHead(business, m[2] ? 'owner' : 'client'))
              res.setHeader('Content-Type', 'text/html; charset=utf-8')
              return res.end(await server.transformIndexHtml(req.url ?? '/', html))
            }
          }
        } catch (e) {
          return next(e)
        }
        next()
      })
    },
  }
}
