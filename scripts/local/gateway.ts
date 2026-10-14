// Local API gateway on :54321 with the same URL layout as a hosted Supabase
// project, so the frontend and Edge Functions use identical code paths:
//   /rest/v1/*       -> PostgREST
//   /auth/v1/*       -> Supabase Auth (GoTrue)
//   /functions/v1/*  -> local Edge Functions (Deno)
//   /storage/v1/*    -> LOCAL STORAGE ADAPTER: a small subset of the Storage
//                       API (public read, upload) backed by .local/storage.
//                       Its write rule mirrors the storage.objects policies
//                       in migration 1200. It is not Supabase Storage.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import pg from 'pg'
import { JWT_SECRET, PG, PORTS, STORAGE_DIR, dbUrl } from './config.ts'

const pool = new pg.Pool({ connectionString: dbUrl(PG.database), max: 3 })

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-upsert, idempotency-key, prefer, range, accept-profile, content-profile, x-supabase-api-version',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Expose-Headers': 'content-range, x-total-count',
}

function verifyJwt(token: string | undefined): Record<string, any> | null {
  if (!token) return null
  const [h, b, s] = token.split('.')
  if (!h || !b || !s) return null
  const expected = createHmac('sha256', JWT_SECRET).update(`${h}.${b}`).digest()
  const got = Buffer.from(s, 'base64url')
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null
  const claims = JSON.parse(Buffer.from(b, 'base64url').toString())
  if (claims.exp && claims.exp * 1000 < Date.now()) return null
  return claims
}

function proxy(req: http.IncomingMessage, res: http.ServerResponse, port: number, pathname: string) {
  const upstream = http.request({ host: '127.0.0.1', port, method: req.method, path: pathname, headers: { ...req.headers, host: `127.0.0.1:${port}` } }, (up) => {
    const headers = { ...up.headers, ...CORS }
    res.writeHead(up.statusCode ?? 502, headers)
    up.pipe(res)
  })
  upstream.on('error', (e) => {
    res.writeHead(502, { 'Content-Type': 'application/json', ...CORS })
    res.end(JSON.stringify({ error: 'upstream_unavailable', detail: e.message }))
  })
  req.pipe(upstream)
}

const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }

async function storage(req: http.IncomingMessage, res: http.ServerResponse, rest: string) {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...CORS })
    res.end(JSON.stringify(body))
  }
  const pub = rest.match(/^object\/public\/([a-z0-9-]+)\/(.+)$/)
  if (pub && (req.method === 'GET' || req.method === 'HEAD')) {
    const file = path.join(STORAGE_DIR, pub[1]!, decodeURIComponent(pub[2]!.split('?')[0]!))
    if (!file.startsWith(STORAGE_DIR) || !existsSync(file) || !statSync(file).isFile()) return send(404, { error: 'not_found' })
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'public, max-age=60', ...CORS })
    return createReadStream(file).pipe(res)
  }
  const up = rest.match(/^object\/([a-z0-9-]+)\/(.+)$/)
  if (up && (req.method === 'POST' || req.method === 'PUT')) {
    const claims = verifyJwt(req.headers.authorization?.replace(/^Bearer\s+/i, ''))
    if (!claims) return send(401, { error: 'unauthorized' })
    const objectPath = decodeURIComponent(up[2]!)
    if (claims.role !== 'service_role') {
      const [tenant, folder] = objectPath.split('/')
      const ok = claims.role === 'authenticated' && folder === 'owner' && /^[0-9a-f-]{36}$/.test(tenant ?? '') &&
        (await pool.query('select 1 from public.tenant_members where tenant_id = $1 and user_id = $2', [tenant, claims.sub])).rowCount
      if (!ok) return send(403, { error: 'new row violates row-level security policy' })
    }
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = Buffer.concat(chunks)
    if (body.length > 5 * 1024 * 1024) return send(413, { error: 'payload_too_large' })
    const file = path.join(STORAGE_DIR, up[1]!, objectPath)
    if (!file.startsWith(STORAGE_DIR)) return send(400, { error: 'invalid_path' })
    if (existsSync(file) && req.headers['x-upsert'] !== 'true' && req.method === 'POST') return send(409, { error: 'Duplicate' })
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, body)
    return send(200, { Key: `${up[1]}/${objectPath}` })
  }
  return send(404, { error: 'not_supported_by_local_storage_adapter' })
}

http.createServer((req, res) => {
  const url = req.url ?? '/'
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end() }
  const m = url.match(/^\/(rest|auth|functions|storage)\/v1(\/.*)?$/)
  if (!m) { res.writeHead(404, CORS); return res.end() }
  const rest = m[2] ?? '/'
  switch (m[1]) {
    case 'rest': return proxy(req, res, PORTS.postgrest, rest)
    case 'auth': return proxy(req, res, PORTS.auth, rest)
    case 'functions': return proxy(req, res, PORTS.functions, rest)
    case 'storage': storage(req, res, rest.slice(1)).catch((e) => { res.writeHead(500, CORS); res.end(String(e)) })
  }
}).listen(PORTS.gateway, '127.0.0.1', () => console.log(`gateway on :${PORTS.gateway}`))
