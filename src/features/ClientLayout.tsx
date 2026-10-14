import { Bot, ReceiptText, ShoppingBasket, Store } from 'lucide-react'
import { Outlet } from 'react-router'
import { Badge } from '@astryxdesign/core/Badge'
import { Text } from '@astryxdesign/core/Text'
import { Button } from '@astryxdesign/core/Button'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { VStack } from '@astryxdesign/core/VStack'
import { Skeleton } from '@astryxdesign/core/Skeleton'
import { ShopProvider, useShop, useSlug } from '@/app/shop-context'
import { BottomNav } from '@/components/BottomNav'
import { useCart } from '@/lib/cart'
import { errorCode, errorMessage } from '@/lib/errors'
import { useServiceWorker } from '@/lib/sw'

function Frame() {
  const shop = useShop()
  const slug = useSlug()
  const cart = useCart(slug)
  useServiceWorker(slug, 'client')
  const base = `/s/${slug}`
  const items = [
    { to: `${base}/`, label: 'Каталог', icon: Store, end: true },
    { to: `${base}/cart`, label: 'Корзина', icon: ShoppingBasket, badge: cart.count },
    { to: `${base}/orders`, label: 'Заказы', icon: ReceiptText },
    ...(shop.tenant.profile.ai?.enabled === false ? [] : [{ to: `${base}/assistant`, label: 'Помощник', icon: Bot }]),
  ]
  return (
    <div className="app-frame" style={{ ['--bottom-nav-height' as string]: '64px' }}>
      {shop.tenant.status === 'preview' ? (
        <div className="preview-flag" role="note">
          <Badge label="Демо-режим" variant="warning" />
          <Text type="supporting" size="2xs"> заказы демонстрационные, уведомления не отправляются</Text>
        </div>
      ) : null}
      <main id="main" className="app-main"><Outlet /></main>
      <BottomNav items={items} label="Разделы магазина" />
    </div>
  )
}

export function ClientLayout() {
  return (
    <ShopProvider fallback={(q) => q.isError ? (
      <VStack padding={6} minHeight="100dvh" vAlign="center">
        <EmptyState title={errorCode(q.error) === 'tenant_not_found' ? 'Магазин не найден' : 'Не удалось открыть магазин'}
          description={errorMessage(q.error)} actions={<Button label="Повторить" variant="primary" onClick={() => q.refetch()} />} />
      </VStack>
    ) : (
      <VStack gap={4} padding={4} aria-busy="true" aria-label="Загрузка магазина">
        <Skeleton height={220} radius={4} /><Skeleton height={28} width="60%" index={1} />
        <Skeleton height={88} index={2} /><Skeleton height={88} index={3} /><Skeleton height={88} index={4} />
      </VStack>
    )}>
      <Frame />
    </ShopProvider>
  )
}
