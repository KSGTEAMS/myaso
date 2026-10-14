// Minimal typed wrapper over supabase-js RPC so handlers can be tested with
// any implementation of `Rpc` (the local stack uses the real one).
import { HttpError, fromDbError } from './http.ts'

export interface RpcResult { data: unknown; error: { message?: string; details?: string | null; code?: string } | null }
export interface RpcClient { rpc(fn: string, args?: Record<string, unknown>): PromiseLike<RpcResult> }

export async function call<T = any>(client: RpcClient, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await client.rpc(fn, args)
  if (error) throw fromDbError(error)
  return data as T
}

export interface RateRule { bucket: string; limit: number; windowSeconds: number }

/** Shared fixed-window limits in Postgres; all must pass. */
export async function enforceRateLimits(service: RpcClient, rules: RateRule[]): Promise<void> {
  for (const r of rules) {
    const res = await call<{ allowed: boolean; reset_at: string }>(service, 'rate_limit_hit', {
      p_bucket: r.bucket, p_limit: r.limit, p_window_seconds: r.windowSeconds,
    })
    if (!res.allowed) throw new HttpError(429, 'rate_limited', res.reset_at)
  }
}
