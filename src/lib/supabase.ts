import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { env } from './env'

/** Anonymous client for public catalog reads (no session is ever stored). */
export const publicDb: SupabaseClient = createClient(env.supabaseUrl, env.anonKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
})

const ownerClients = new Map<string, SupabaseClient>()

/**
 * Owner client per shop. The session lives under a shop-specific storage key
 * and is removed on sign-out together with the private query cache.
 */
export function ownerDb(slug: string): SupabaseClient {
  let c = ownerClients.get(slug)
  if (!c) {
    c = createClient(env.supabaseUrl, env.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: `owner-session:${slug}` },
    })
    ownerClients.set(slug, c)
  }
  return c
}

export function functionsUrl(name: string) {
  return `${env.supabaseUrl}/functions/v1/${name}`
}

export function mediaUrl(pathOrNull: string | null | undefined, width: number): string | null {
  if (!pathOrNull) return null
  if (pathOrNull.startsWith('static:')) return `${pathOrNull.slice('static:'.length)}-${width}.webp`
  return `${env.supabaseUrl}/storage/v1/object/public/tenant-media/${pathOrNull}`
}

export function mediaSrcSet(p: string | null | undefined, widths: number[]): string | undefined {
  if (!p?.startsWith('static:')) return undefined
  return widths.map((w) => `${mediaUrl(p, w)} ${w}w`).join(', ')
}
