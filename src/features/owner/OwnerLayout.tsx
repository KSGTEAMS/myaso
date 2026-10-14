import { BarChart3, CalendarClock, Ellipsis, ListOrdered, Warehouse } from 'lucide-react'
import { Outlet } from 'react-router'
import { Badge } from '@astryxdesign/core/Badge'
import { Button } from '@astryxdesign/core/Button'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { Spinner } from '@astryxdesign/core/Spinner'
import { VStack } from '@astryxdesign/core/VStack'
import { ShopProvider, useSlug } from '@/app/shop-context'
import { BottomNav } from '@/components/BottomNav'
import { errorMessage } from '@/lib/errors'
import { useServiceWorker } from '@/lib/sw'
import { OwnerGate, useOwner } from './owner-context'

function Frame() {
  const slug = useSlug()
  const { tenant } = useOwner()
  useServiceWorker(slug, 'owner')
  const base = `/s/${slug}/owner`
  return (
    <div className="app-frame" style={{ ['--bottom-nav-height' as string]: '64px' }}>
      {tenant.status === 'preview' ? <div className="preview-flag"><Badge label="Демо-режим: данные помечены как демо, уведомления не отправляются" variant="warning" /></div> : null}
      <main id="main" className="app-main"><Outlet /></main>
      <BottomNav label="Разделы кабинета" items={[
        { to: `${base}/`, label: 'Сегодня', icon: CalendarClock, end: true },
        { to: `${base}/orders`, label: 'Заказы', icon: ListOrdered },
        { to: `${base}/resources`, label: 'Ресурсы', icon: Warehouse },
        { to: `${base}/stats`, label: 'Статистика', icon: BarChart3 },
        { to: `${base}/more`, label: 'Ещё', icon: Ellipsis },
      ]} />
    </div>
  )
}

export function OwnerLayout() {
  return (
    <ShopProvider fallback={(q) => q.isError
      ? <EmptyState title="Магазин недоступен" description={errorMessage(q.error)} actions={<Button label="Повторить" onClick={() => q.refetch()} />} />
      : <VStack minHeight="100dvh" vAlign="center" hAlign="center"><Spinner size="lg" /></VStack>}>
      <OwnerGate><Frame /></OwnerGate>
    </ShopProvider>
  )
}
