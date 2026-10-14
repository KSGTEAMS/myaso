// HTTP helpers shared by all Edge Functions. Pure TypeScript (no Deno APIs)
// so the same code runs under Deno and in Node tests.

export type Env = (name: string) => string | undefined

export class HttpError extends Error {
  constructor(public status: number, public code: string, public detail?: string) {
    super(code)
  }
}

// Stable SQL error codes (raised by private.fail) -> HTTP status.
const STATUS_BY_CODE: Record<string, number> = {
  tenant_not_found: 404,
  order_not_found: 404,
  product_not_found: 404,
  resource_not_found: 404,
  slot_taken: 409,
  idempotency_conflict: 409,
  resource_busy: 409,
  forbidden: 403,
  rate_limited: 429,
  llm_budget_exceeded: 429,
}

export function statusForCode(code: string): number {
  return STATUS_BY_CODE[code] ?? (/^[a-z_]+$/.test(code) ? 422 : 500)
}

export function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  const allowed = (env('ALLOWED_ORIGINS') ?? '*').split(',').map((s) => s.trim()).filter(Boolean)
  const allow = allowed.includes('*') ? '*' : origin && allowed.includes(origin) ? origin : allowed[0] ?? 'null'
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, idempotency-key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  })
}

export function errorResponse(e: unknown, headers: Record<string, string>): Response {
  if (e instanceof HttpError) {
    return json({ error: e.code, detail: e.detail ?? null }, e.status, headers)
  }
  console.error('unhandled', e)
  return json({ error: 'internal_error' }, 500, headers)
}

/** Map a PostgREST/supabase-js error to HttpError, preserving our SQL codes. */
export function fromDbError(err: { message?: string; details?: string | null; code?: string } | null): HttpError {
  const code = err?.message ?? 'internal_error'
  if (err?.code === 'P0001' || /^[a-z_]+$/.test(code)) {
    return new HttpError(statusForCode(code), code, err?.details ?? undefined)
  }
  if (err?.code === '42501') return new HttpError(403, 'forbidden')
  return new HttpError(500, 'internal_error')
}

/**
 * Client address used only for rate-limit buckets (hashed with a salt).
 * IP_HEADER selects the header set by the trusted proxy in front of the
 * function (Supabase: x-forwarded-for). Tenant-wide buckets cap abuse even
 * if an address can be spoofed.
 */
export function clientIp(req: Request, env?: Env): string {
  const header = (env?.('IP_HEADER') ?? 'x-forwarded-for').toLowerCase()
  const v = req.headers.get(header)
  return v?.split(',')[0]?.trim() || 'unknown'
}

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function readJson(req: Request, maxBytes = 32_000): Promise<Record<string, unknown>> {
  const text = await req.text()
  if (text.length > maxBytes) throw new HttpError(413, 'payload_too_large')
  try {
    const v = JSON.parse(text || '{}')
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error()
    return v as Record<string, unknown>
  } catch {
    throw new HttpError(400, 'invalid_json')
  }
}
