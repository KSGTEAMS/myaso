import { createContext, useContext, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useParams } from 'react-router'
import { fetchShop } from '@/api/shop'
import type { Shop } from '@/api/types'
import { shellMeta } from '@/lib/tenant-meta'
import { TenantTheme } from '@/theme/TenantTheme'

const ShopCtx = createContext<Shop | null>(null)

export function useSlug(): string {
  const { slug } = useParams()
  return slug ?? ''
}

export function useShop(): Shop {
  const s = useContext(ShopCtx)
  if (!s) throw new Error('useShop outside ShopProvider')
  return s
}

export const shopQueryKey = (slug: string) => ['shop', slug] as const

export function useShopQuery(slug: string) {
  return useQuery({ queryKey: shopQueryKey(slug), queryFn: () => fetchShop(slug), staleTime: 60_000 })
}

/** Loads the shop once for the whole subtree and applies its accent. */
export function ShopProvider({ children, fallback }: { children: ReactNode; fallback: (q: ReturnType<typeof useShopQuery>) => ReactNode }) {
  const slug = useSlug()
  const q = useShopQuery(slug)
  const meta = shellMeta()
  const accent = q.data?.tenant.profile.accent ?? (meta.slug === slug ? meta.accent : null)
  const background = q.data?.tenant.profile.background ?? (meta.slug === slug ? meta.background : null)
  return (
    <TenantTheme accent={accent} background={background} id={slug}>
      {q.data ? <ShopCtx.Provider value={q.data}>{children}</ShopCtx.Provider> : fallback(q)}
    </TenantTheme>
  )
}
