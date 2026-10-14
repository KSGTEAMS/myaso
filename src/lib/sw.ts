// One shared /sw.js, registered once per shop and per app with its own scope:
//   /s/<slug>/        storefront
//   /s/<slug>/owner/  owner cabinet
// The worker derives its cache names from the scope, so shops never share
// caches, and it never caches API responses or private data.
import { useEffect } from 'react'

export function swScope(slug: string, kind: 'client' | 'owner') {
  return kind === 'client' ? `/s/${slug}/` : `/s/${slug}/owner/`
}

export function useServiceWorker(slug: string, kind: 'client' | 'owner') {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    if (!import.meta.env.PROD && !import.meta.env.VITE_SW_DEV) return
    navigator.serviceWorker.register('/sw.js', { scope: swScope(slug, kind) }).catch((e) => console.warn('service worker', e))
  }, [slug, kind])
}

export async function registrationFor(slug: string, kind: 'client' | 'owner') {
  if (!('serviceWorker' in navigator)) return null
  const scope = new URL(swScope(slug, kind), location.origin).href
  const existing = await navigator.serviceWorker.getRegistration(scope)
  if (existing?.scope === scope) return existing
  return navigator.serviceWorker.register('/sw.js', { scope: swScope(slug, kind) })
}

/** Ask the worker of this scope to drop its runtime caches (used on logout). */
export async function clearScopeCaches(slug: string, kind: 'client' | 'owner') {
  const reg = await registrationFor(slug, kind).catch(() => null)
  reg?.active?.postMessage({ type: 'CLEAR_RUNTIME_CACHE' })
}
