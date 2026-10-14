// Resolve Supabase credentials for pipeline scripts: explicit env vars win,
// then .env, then the local stack defaults (only when --local or nothing set).
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { ANON_KEY, GATEWAY_URL, ROOT, SERVICE_ROLE_KEY } from '../local/config.ts'

export function loadEnvFile(file = path.join(ROOT, '.env')) {
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, '')
  }
}

export interface Target { url: string; serviceKey: string; anonKey: string; local: boolean }

export function resolveTarget(argv = process.argv): Target {
  loadEnvFile()
  const forceLocal = argv.includes('--local')
  const url = forceLocal ? undefined : process.env.SUPABASE_URL
  if (!url) return { url: GATEWAY_URL, serviceKey: SERVICE_ROLE_KEY, anonKey: ANON_KEY, local: true }
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY
  if (!serviceKey || !anonKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are required for a remote project')
  return { url, serviceKey, anonKey, local: false }
}

export function serviceClient(t: Target): SupabaseClient {
  return createClient(t.url, t.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
}

export function arg(name: string, argv = process.argv): string | undefined {
  const i = argv.indexOf(`--${name}`)
  if (i >= 0) return argv[i + 1]
  return argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=')
}

export async function rpc<T = any>(c: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await c.rpc(fn, args)
  if (error) throw new Error(`${fn}: ${error.message}${error.details && error.details !== error.message ? ` (${error.details})` : ''}`)
  return data as T
}
