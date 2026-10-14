import { useQueries } from '@tanstack/react-query'
import { Badge } from '@astryxdesign/core/Badge'
import { Button } from '@astryxdesign/core/Button'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { Item } from '@astryxdesign/core/Item'
import { List } from '@astryxdesign/core/List'
import { Skeleton } from '@astryxdesign/core/Skeleton'
import { VStack } from '@astryxdesign/core/VStack'
import { publicApi } from '@/api/public'
import { useShop, useSlug } from '@/app/shop-context'
import { PageHeader } from '@/components/PageHeader'
import { STATUS_LABEL, dateTime } from '@/lib/format'
import { myOrdersStore } from '@/lib/my-orders'

export function OrdersPage() {
  const slug = useSlug()
  const shop = useShop()
  const refs = myOrdersStore(slug).use()
  const results = useQueries({ queries: refs.map((r) => ({ queryKey: ['order', r.id], queryFn: () => publicApi.get(r.id, r.token), staleTime: 30_000 })) })
  if (!refs.length) {
    return (
      <VStack><PageHeader title="Мои заказы" />
        <EmptyState title="Заказов пока нет" description="Здесь появятся заказы, оформленные на этом устройстве."
          actions={<Button label="В каталог" variant="primary" href={`/s/${slug}/`} />} />
      </VStack>
    )
  }
  return (
    <VStack>
      <PageHeader title="Мои заказы" />
      <List hasDividers aria-label="Мои заказы">
        {refs.map((r, i) => {
          const q = results[i]!
          const o = q.data
          return (
            <Item key={r.id} as="li" href={`/s/${slug}/orders/${r.id}`}
              label={`Заказ №${r.number}`}
              description={q.isPending ? <Skeleton height={14} width={160} /> : q.isError ? 'Не удалось обновить статус' : dateTime(o!.pickup_at, shop.tenant.timezone)}
              endContent={o ? <Badge label={STATUS_LABEL[o.status] ?? o.status} variant={o.status === 'cancelled' ? 'error' : o.status === 'ready' ? 'success' : 'neutral'} /> : null} />
          )
        })}
      </List>
    </VStack>
  )
}
