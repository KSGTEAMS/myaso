// Honest Web Push capability detection. iPhone/iPad Safari delivers Web Push
// only to a site installed on the Home Screen (iOS 16.4+), never to a tab.
import { env } from './env'
import { registrationFor } from './sw'

export type PushState =
  | { kind: 'unsupported'; reason: string }
  | { kind: 'ios-install' }
  | { kind: 'no-config' }
  | { kind: 'denied' }
  | { kind: 'available' }
  | { kind: 'subscribed'; endpoint: string }

export const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true

export async function pushState(slug: string, kind: 'client' | 'owner'): Promise<PushState> {
  if (!env.vapidPublicKey) return { kind: 'no-config' }
  if (isIos() && !isStandalone()) return { kind: 'ios-install' }
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return { kind: 'unsupported', reason: 'Этот браузер не поддерживает push-уведомления.' }
  }
  if (Notification.permission === 'denied') return { kind: 'denied' }
  const reg = await registrationFor(slug, kind)
  const sub = await reg?.pushManager.getSubscription()
  return sub ? { kind: 'subscribed', endpoint: sub.endpoint } : { kind: 'available' }
}

function keyBytes(b64: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4)
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

export async function subscribePush(slug: string, kind: 'client' | 'owner'): Promise<PushSubscriptionJSON> {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('permission_denied')
  const reg = await registrationFor(slug, kind)
  if (!reg) throw new Error('no_service_worker')
  await navigator.serviceWorker.ready
  const sub = (await reg.pushManager.getSubscription())
    ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(env.vapidPublicKey) })
  return sub.toJSON()
}

export async function unsubscribePush(slug: string, kind: 'client' | 'owner'): Promise<string | null> {
  const reg = await registrationFor(slug, kind)
  const sub = await reg?.pushManager.getSubscription()
  if (!sub) return null
  await sub.unsubscribe()
  return sub.endpoint
}
