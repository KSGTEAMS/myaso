/// <reference lib="webworker" />
// One worker script, registered per shop and per app (storefront /s/<slug>/,
// cabinet /s/<slug>/owner/). Everything is namespaced by that scope:
//   - cache names: shop-<slug>-<kind>-*
//   - the cached shell is that shop's own HTML
// Only static, public files are cached. API calls (Supabase, Edge Functions),
// order data and owner data never touch the worker caches.
import { clientsClaim, setCacheNameDetails } from 'workbox-core'
import { ExpirationPlugin } from 'workbox-expiration'
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching'
import { registerRoute } from 'workbox-routing'
import { CacheFirst } from 'workbox-strategies'

declare const self: ServiceWorkerGlobalScope

const scopePath = new URL(self.registration.scope).pathname          // /s/<slug>/ or /s/<slug>/owner/
const match = scopePath.match(/^\/s\/([a-z0-9-]+)\/(owner\/)?$/)
const slug = match?.[1] ?? 'unknown'
const kind = match?.[2] ? 'owner' : 'client'
const prefix = `shop-${slug}-${kind}`
const SHELL_CACHE = `${prefix}-shell-v1`
const MEDIA_CACHE = `${prefix}-media`

setCacheNameDetails({ prefix, suffix: 'v1' })
self.skipWaiting()
clientsClaim()
cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)

// The shop shell: refreshed on install, used when the network is down.
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.add(new Request(scopePath, { cache: 'reload' }))).catch(() => undefined))
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Remove caches of this scope from older versions only — never another shop's.
    for (const name of await caches.keys()) {
      if (name.startsWith(`${prefix}-shell-`) && name !== SHELL_CACHE) await caches.delete(name)
    }
  })())
})

// Navigations inside this scope: network first, shop shell as offline fallback.
registerRoute(
  ({ request, url }) => request.mode === 'navigate' && url.origin === self.location.origin && url.pathname.startsWith(scopePath),
  async ({ request }) => {
    try {
      const res = await fetch(request)
      if (res.ok && kind === 'client') {
        const cache = await caches.open(SHELL_CACHE)
        await cache.put(scopePath, res.clone())
      }
      return res
    } catch {
      const cached = await caches.match(scopePath, { cacheName: SHELL_CACHE })
      return cached ?? Response.error()
    }
  },
)

// Public product photos of this shop only (content-hashed, immutable).
registerRoute(
  ({ url }) => url.origin === self.location.origin && url.pathname.startsWith(`/t/${slug}/`),
  new CacheFirst({ cacheName: MEDIA_CACHE, plugins: [new ExpirationPlugin({ maxEntries: 120, maxAgeSeconds: 30 * 86400 })] }),
)

self.addEventListener('message', (event) => {
  if (event.data?.type === 'CLEAR_RUNTIME_CACHE') {
    event.waitUntil((async () => { for (const n of await caches.keys()) if (n.startsWith(prefix) && !n.includes('precache')) await caches.delete(n) })())
  }
})

interface PushPayload { title: string; body: string; url?: string; tag?: string }

self.addEventListener('push', (event) => {
  let data: PushPayload = { title: 'Новое уведомление', body: '' }
  try { data = event.data?.json() as PushPayload } catch { /* keep default */ }
  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    tag: data.tag,
    data: { url: data.url ?? scopePath },
    icon: `/t/${slug}/icons/${kind === 'owner' ? 'owner-' : ''}icon-192.png`,
    badge: `/t/${slug}/icons/favicon-32.png`,
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = new URL((event.notification.data as { url?: string })?.url ?? scopePath, self.location.origin)
  // Stay inside this worker's scope; fall back to the scope root.
  const url = target.origin === self.location.origin && target.pathname.startsWith(scopePath) ? target.href : new URL(scopePath, self.location.origin).href
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const existing = windows.find((w) => new URL(w.url).pathname.startsWith(scopePath))
    if (existing) { await existing.focus(); await existing.navigate(url).catch(() => undefined); return }
    await self.clients.openWindow(url)
  })())
})
