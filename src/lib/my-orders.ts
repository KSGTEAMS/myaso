// Orders placed from this device. The access token is the only key to an
// order (no customer accounts); it never leaves the device except in API
// calls and the personal link. Only its hash is stored server-side.
import { store } from './store'

export interface OrderRef { id: string; token: string; number: number; pickup_at: string; created_at: string }

export const myOrdersStore = (slug: string) => store<OrderRef[]>(`orders:${slug}`, [])

export function rememberOrder(slug: string, ref: OrderRef) {
  myOrdersStore(slug).set((prev) => [ref, ...prev.filter((o) => o.id !== ref.id)].slice(0, 50))
}

export function forgetOrder(slug: string, id: string) {
  myOrdersStore(slug).set((prev) => prev.filter((o) => o.id !== id))
}

export function tokenFor(slug: string, id: string): string | null {
  return myOrdersStore(slug).get().find((o) => o.id === id)?.token ?? null
}

/** Personal link; the token travels in the fragment so it never hits server logs. */
export function orderLink(slug: string, id: string, token: string) {
  return `${location.origin}/s/${slug}/orders/${id}#t=${token}`
}

/** Pending checkout: the idempotency key survives reloads so a retry after a
 *  lost response returns the very same order and token. */
export const pendingCheckout = (slug: string) => store<{ key: string; fingerprint: string } | null>(`checkout:${slug}`, null)
