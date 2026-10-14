import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { Button } from '@astryxdesign/core/Button'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { Spinner } from '@astryxdesign/core/Spinner'
import { VStack } from '@astryxdesign/core/VStack'
import { ownerApi, ownerTenants, type OwnerTenant } from '@/api/owner'
import { useSlug } from '@/app/shop-context'
import { errorMessage } from '@/lib/errors'
import { unsubscribePush } from '@/lib/push'
import { ownerDb } from '@/lib/supabase'
import { clearScopeCaches } from '@/lib/sw'
import { LoginPage } from './LoginPage'

interface OwnerCtxValue {
  db: SupabaseClient
  tenant: OwnerTenant
  api: ReturnType<typeof ownerApi>
  session: Session
  logout: () => Promise<void>
  /** Query key prefix: everything private sits under it and is dropped on logout. */
  key: (...parts: unknown[]) => unknown[]
}

const OwnerCtx = createContext<OwnerCtxValue | null>(null)

export function useOwner(): OwnerCtxValue {
  const v = useContext(OwnerCtx)
  if (!v) throw new Error('useOwner outside OwnerGate')
  return v
}

function useSession(db: SupabaseClient) {
  const [state, setState] = useState<{ ready: boolean; session: Session | null }>({ ready: false, session: null })
  useEffect(() => {
    let alive = true
    db.auth.getSession().then(({ data }) => alive && setState({ ready: true, session: data.session }))
    const { data } = db.auth.onAuthStateChange((_e, session) => setState({ ready: true, session }))
    return () => { alive = false; data.subscription.unsubscribe() }
  }, [db])
  return state
}

/**
 * Owner area guard: a Supabase Auth session AND a membership row for this
 * shop, confirmed by the server (owner_tenants). There is no sign-up.
 */
export function OwnerGate({ children }: { children: ReactNode }) {
  const slug = useSlug()
  const db = useMemo(() => ownerDb(slug), [slug])
  const qc = useQueryClient()
  const { ready, session } = useSession(db)
  const memberships = useQuery({
    queryKey: ['owner', slug, 'memberships', session?.user.id],
    queryFn: () => ownerTenants(db),
    enabled: !!session,
  })

  const logout = useCallback(async () => {
    const tenant = memberships.data?.find((t) => t.slug === slug)
    try {
      const endpoint = await unsubscribePush(slug, 'owner').catch(() => null)
      if (endpoint && tenant) await ownerApi(db, tenant.id).unregisterPush(endpoint).catch(() => {})
    } finally {
      await db.auth.signOut({ scope: 'local' })
      qc.removeQueries({ queryKey: ['owner', slug] })
      await clearScopeCaches(slug, 'owner').catch(() => {})
    }
  }, [db, memberships.data, qc, slug])

  if (!ready) return <VStack minHeight="100dvh" vAlign="center" hAlign="center"><Spinner size="lg" label="Проверяем вход" /></VStack>
  if (!session) return <LoginPage db={db} />
  if (memberships.isPending) return <VStack minHeight="100dvh" vAlign="center" hAlign="center"><Spinner size="lg" label="Проверяем доступ" /></VStack>
  if (memberships.isError) {
    return <EmptyState title="Не удалось проверить доступ" description={errorMessage(memberships.error)}
      actions={<><Button label="Повторить" onClick={() => memberships.refetch()} /><Button label="Выйти" variant="ghost" onClick={logout} /></>} />
  }
  const tenant = memberships.data.find((t) => t.slug === slug)
  if (!tenant) {
    return (
      <VStack minHeight="100dvh" vAlign="center" padding={6}>
        <EmptyState title="Нет доступа к этому магазину" description={`Аккаунт ${session.user.email ?? ''} не привязан к кабинету этого магазина.`}
          actions={<Button label="Выйти" variant="primary" onClick={logout} />} />
      </VStack>
    )
  }
  const value: OwnerCtxValue = { db, tenant, session, logout, api: ownerApi(db, tenant.id), key: (...parts) => ['owner', slug, ...parts] }
  return <OwnerCtx.Provider value={value}>{children}</OwnerCtx.Provider>
}
