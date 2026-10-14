// Tiny persisted stores (per-device conveniences). Every access is guarded:
// storage can be unavailable (private mode) and the app must still work.
import { useSyncExternalStore } from 'react'

export function createPersistedStore<T>(key: string, initial: T) {
  let value: T = initial
  try {
    const raw = localStorage.getItem(key)
    if (raw) value = JSON.parse(raw) as T
  } catch { /* storage unavailable */ }
  const listeners = new Set<() => void>()
  const set = (next: T | ((prev: T) => T)) => {
    value = typeof next === 'function' ? (next as (p: T) => T)(value) : next
    try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* ignore */ }
    listeners.forEach((l) => l())
  }
  const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l) }
  return {
    get: () => value,
    set,
    subscribe,
    remove: () => { try { localStorage.removeItem(key) } catch { /* ignore */ } value = initial; listeners.forEach((l) => l()) },
    use: () => useSyncExternalStore(subscribe, () => value, () => value),
  }
}

const cache = new Map<string, ReturnType<typeof createPersistedStore<any>>>()
export function store<T>(key: string, initial: T): ReturnType<typeof createPersistedStore<T>> {
  if (!cache.has(key)) cache.set(key, createPersistedStore(key, initial))
  return cache.get(key)!
}
