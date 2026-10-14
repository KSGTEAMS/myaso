import { store } from './store'
import type { CartLine, Product } from '@/api/types'

export const cartStore = (slug: string) => store<CartLine[]>(`cart:${slug}`, [])

export function useCart(slug: string) {
  const s = cartStore(slug)
  const lines = s.use()
  return {
    lines,
    count: lines.length,
    quantityOf: (productId: string) => lines.find((l) => l.product_id === productId)?.quantity ?? 0,
    setQuantity: (p: Product, q: number) => s.set((prev) => {
      const rest = prev.filter((l) => l.product_id !== p.id)
      if (q <= 0) return rest
      const clamped = Math.min(p.max_qty, Math.max(p.min_qty, Math.round(q / p.qty_step) * p.qty_step))
      const line = { product_id: p.id, quantity: Number(clamped.toFixed(3)) }
      const idx = prev.findIndex((l) => l.product_id === p.id)
      if (idx < 0) return [...prev, line]
      const copy = [...prev]
      copy[idx] = line
      return copy
    }),
    clear: () => s.set([]),
  }
}

/** Drop lines whose product disappeared or changed limits. */
export function reconcileCart(lines: CartLine[], products: Product[]): CartLine[] {
  const byId = new Map(products.map((p) => [p.id, p]))
  return lines.filter((l) => {
    const p = byId.get(l.product_id)
    if (!p) return false
    const steps = l.quantity / p.qty_step
    return l.quantity >= p.min_qty && l.quantity <= p.max_qty && Math.abs(steps - Math.round(steps)) < 1e-9
  })
}
