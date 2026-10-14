// Static server for dist/ that applies the same rules as Cloudflare Pages
// (_redirects rewrites and _headers) — used by e2e tests and tenant:verify.
//   npx tsx scripts/serve-dist.ts [port]
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { ROOT } from './lib/tenant.ts'

const DIST = path.join(ROOT, 'dist')
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.map': 'application/json', '.txt': 'text/plain',
}

interface Rule { from: RegExp; to: string; keys: string[] }

function parseRedirects(): Rule[] {
  const file = path.join(DIST, '_redirects')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => {
    const [from, to] = l.split(/\s+/)
    const keys: string[] = []
    const re = from!.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/:(\w+)/g, (_m, k) => { keys.push(k); return '([^/]+)' }).replace(/\*/g, '(.*)')
    return { from: new RegExp(`^${re}$`), to: to!, keys }
  })
}

function headersFor(p: string): Record<string, string> {
  const file = path.join(DIST, '_headers')
  if (!existsSync(file)) return {}
  const out: Record<string, string> = {}
  let match = false
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    if (!line.startsWith(' ')) {
      match = new RegExp(`^${line.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(p)
    } else if (match) {
      const [k, ...v] = line.trim().split(':')
      out[k!] = v.join(':').trim()
    }
  }
  return out
}

export function serveDist(port = 4173) {
  const rules = parseRedirects()
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    let p = decodeURIComponent(url.pathname)
    const resolve = (q: string) => {
      const f = path.join(DIST, q.endsWith('/') ? `${q}index.html` : q)
      return f.startsWith(DIST) && existsSync(f) && statSync(f).isFile() ? f : null
    }
    let file = resolve(p)
    if (!file || p.startsWith('/s/')) {
      for (const r of rules) {
        const m = p.match(r.from)
        if (!m) continue
        let to = r.to
        r.keys.forEach((k, i) => { to = to.replace(`:${k}`, m[i + 1]!) })
        p = to
        file = resolve(p)
        break
      }
    }
    if (!file) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found') }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', ...headersFor(url.pathname) })
    createReadStream(file).pipe(res)
  }).listen(port, '127.0.0.1')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 4173)
  serveDist(port)
  console.log(`dist served on http://127.0.0.1:${port} with _redirects/_headers`)
}
