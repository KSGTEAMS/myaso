import { useDeferredValue, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { Heading } from '@astryxdesign/core/Heading'
import { List } from '@astryxdesign/core/List'
import { TextInput } from '@astryxdesign/core/TextInput'
import { VStack } from '@astryxdesign/core/VStack'
import type { Order } from '@/api/types'
import { useShop, useSlug } from '@/app/shop-context'
import { PageHeader } from '@/components/PageHeader'
import { QueryState } from '@/components/QueryState'
import { addDays, dayLabel, localToday } from '@/lib/format'
import { OrderRow } from './parts'
import { useOwner } from './owner-context'

export function OwnerOrdersPage() {
  const { api, key } = useOwner()
  const shop = useShop()
  const slug = useSlug()
  const tz = shop.tenant.timezone
  const [text, setText] = useState('')
  const query = useDeferredValue(text.trim())
  const today = localToday(tz)
  const upcoming = useQuery({ queryKey: key('schedule', today, addDays(today, 13)), queryFn: () => api.schedule(today, addDays(today, 13)), enabled: !query })
  const found = useQuery({ queryKey: key('find', query), queryFn: () => api.find(query), enabled: !!query })
  const groups = (orders: Order[]) => {
    const m = new Map<string, Order[]>()
    for (const o of orders) {
      const d = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(o.pickup_at))
      m.set(d, [...(m.get(d) ?? []), o])
    }
    return [...m.entries()]
  }
  return (
    <VStack>
      <PageHeader title="Заказы" />
      <VStack gap={4} paddingInline={4} paddingBlockEnd={6}>
        <TextInput label="Поиск" isLabelHidden placeholder="Номер, телефон или имя" value={text} onChange={setText} hasClear startIcon={Search} />
        {query ? (
          <QueryState query={found} isEmpty={(d) => d.length === 0} empty={{ title: 'Ничего не найдено', description: 'Проверьте номер заказа или телефон.' }}>
            {(list) => <List hasDividers density="compact">{list.map((o) => <OrderRow key={o.id} order={o} tz={tz} href={`/s/${slug}/owner/orders/${o.id}`} />)}</List>}
          </QueryState>
        ) : (
          <QueryState query={upcoming} isEmpty={(d) => d.orders.length === 0} empty={{ title: 'Ближайших заказов нет', description: 'Здесь появятся заказы на 14 дней вперёд.' }}>
            {(s) => (
              <VStack gap={4}>
                {groups(s.orders).map(([day, list]) => {
                  const l = dayLabel(day)
                  return (
                    <VStack key={day} gap={1}>
                      <Heading level={3}>{l.weekday}, {l.day} {l.month}</Heading>
                      <List hasDividers density="compact">{list.map((o) => <OrderRow key={o.id} order={o} tz={tz} href={`/s/${slug}/owner/orders/${o.id}`} />)}</List>
                    </VStack>
                  )
                })}
              </VStack>
            )}
          </QueryState>
        )}
      </VStack>
    </VStack>
  )
}
