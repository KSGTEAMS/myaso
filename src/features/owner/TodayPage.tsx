import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { Button } from '@astryxdesign/core/Button'
import { Heading } from '@astryxdesign/core/Heading'
import { HStack } from '@astryxdesign/core/HStack'
import { Icon } from '@astryxdesign/core/Icon'
import { List } from '@astryxdesign/core/List'
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl'
import { StackItem } from '@astryxdesign/core/Stack'
import { Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import { useShop, useSlug } from '@/app/shop-context'
import { PageHeader } from '@/components/PageHeader'
import { QueryState } from '@/components/QueryState'
import { useSheet } from '@/components/Sheet'
import { addDays, dayLabel, localToday } from '@/lib/format'
import { NewOrderSheet } from './NewOrderSheet'
import { OrderRow, ResourceTimeline } from './parts'
import { useOwner } from './owner-context'

export function TodayPage() {
  const { api, key } = useOwner()
  const shop = useShop()
  const slug = useSlug()
  const tz = shop.tenant.timezone
  const today = localToday(tz)
  const [day, setDay] = useState(today)
  const newOrder = useSheet('new-order')
  const q = useQuery({ queryKey: key('schedule', day, day), queryFn: () => api.schedule(day, day), refetchInterval: 30_000 })
  const bounds = useQuery({ queryKey: key('bounds', day), queryFn: () => api.bounds('custom', day, day) })
  const l = dayLabel(day)
  return (
    <VStack>
      <PageHeader title="Выдача" end={<Button label="Заказ" icon={<Icon icon={Plus} />} size="sm" variant="primary" onClick={() => newOrder.open()} />} />
      <VStack gap={4} paddingInline={4} paddingBlockEnd={6}>
        <HStack gap={2} vAlign="center">
          <StackItem size="fill">
            <SegmentedControl label="День" value={day === today ? 'today' : day === addDays(today, 1) ? 'tomorrow' : 'other'}
              onChange={(v) => setDay(v === 'today' ? today : v === 'tomorrow' ? addDays(today, 1) : addDays(day, 1))} layout="fill">
              <SegmentedControlItem value="today" label="Сегодня" />
              <SegmentedControlItem value="tomorrow" label="Завтра" />
              <SegmentedControlItem value="other" label={day !== today && day !== addDays(today, 1) ? `${l.day} ${l.month}` : 'Дальше'} />
            </SegmentedControl>
          </StackItem>
        </HStack>
        <QueryState query={q}>
          {(s) => {
            const active = s.orders.filter((o) => o.status !== 'cancelled')
            const waiting = active.filter((o) => o.status === 'confirmed' || o.status === 'ready')
            return (
              <VStack gap={4}>
                <HStack gap={4}>
                  <VStack gap={0}><Heading level={2}>{active.length}</Heading><Text type="supporting">к выдаче</Text></VStack>
                  <VStack gap={0}><Heading level={2}>{waiting.length}</Heading><Text type="supporting">ещё ждут</Text></VStack>
                  <VStack gap={0}><Heading level={2}>{s.orders.length - active.length}</Heading><Text type="supporting">отменено</Text></VStack>
                </HStack>
                {active.length ? (
                  <List hasDividers density="compact" aria-label="Заказы дня">
                    {active.map((o) => <OrderRow key={o.id} order={o} tz={tz} href={`/s/${slug}/owner/orders/${o.id}`} />)}
                  </List>
                ) : <Text type="supporting">На этот день заказов нет.</Text>}
                {bounds.data ? (
                  <VStack gap={2}>
                    <Heading level={3}>Загрузка ресурсов</Heading>
                    <ResourceTimeline schedule={s} dayStart={bounds.data.from_ts} dayEnd={bounds.data.to_ts} tz={tz} />
                  </VStack>
                ) : null}
              </VStack>
            )
          }}
        </QueryState>
      </VStack>
      <NewOrderSheet isOpen={newOrder.isOpen} onClose={newOrder.close} />
    </VStack>
  )
}
