import { Badge } from '@astryxdesign/core/Badge'
import { HStack } from '@astryxdesign/core/HStack'
import { Item } from '@astryxdesign/core/Item'
import { StackItem } from '@astryxdesign/core/Stack'
import { Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import type { Schedule } from '@/api/owner'
import type { Order } from '@/api/types'
import { STATUS_LABEL, money, qty, time } from '@/lib/format'

export function StatusBadge({ status, isDemo }: { status: string; isDemo?: boolean }) {
  const variant = status === 'cancelled' || status === 'no_show' ? 'error' : status === 'ready' ? 'success' : status === 'completed' ? 'neutral' : 'info'
  return (
    <HStack gap={1}>
      {isDemo ? <Badge label="демо" variant="warning" /> : null}
      <Badge label={STATUS_LABEL[status] ?? status} variant={variant} />
    </HStack>
  )
}

export function OrderRow({ order, tz, href }: { order: Order; tz: string; href: string }) {
  const items = order.items.map((i) => `${i.name} ${qty(Number(i.quantity), i.unit)}`).join(', ')
  return (
    <Item as="li" href={href} align="start"
      startContent={<Text type="label" weight="bold" hasTabularNumbers>{time(order.pickup_at, tz)}</Text>}
      label={`№${order.number} · ${order.customer_name}`}
      description={<Text type="supporting" maxLines={2}>{items}</Text>}
      endContent={<VStack gap={1} hAlign="end"><StatusBadge status={order.status} isDemo={order.is_demo} />
        <Text type="supporting" hasTabularNumbers>{money(order.final_amount_cents ?? order.subtotal_cents, order.currency)}</Text></VStack>} />
  )
}

/** Dense per-resource occupancy bar for one local day (orders and blocks). */
export function ResourceTimeline({ schedule, dayStart, dayEnd, tz }: { schedule: Schedule; dayStart: string; dayEnd: string; tz: string }) {
  const from = Date.parse(dayStart)
  const to = Date.parse(dayEnd)
  const span = to - from
  return (
    <VStack gap={2}>
      {schedule.resources.filter((r) => r.is_active).map((r) => {
        const occ = schedule.occupancies.filter((o) => o.resource_id === r.id && Date.parse(o.ends_at) > from && Date.parse(o.starts_at) < to)
        return (
          <VStack key={r.id} gap={1}>
            <HStack gap={2}>
              <StackItem size="fill"><Text type="supporting">{r.name}</Text></StackItem>
              <Text type="supporting">{occ.length ? `занят: ${occ.length}` : 'свободен'}</Text>
            </HStack>
            <div className="timeline-track" role="img" aria-label={`${r.name}: ${occ.map((o) => `${time(o.starts_at, tz)}–${time(o.ends_at, tz)}`).join(', ') || 'свободен весь день'}`}>
              {occ.map((o, i) => {
                const left = Math.max(0, (Date.parse(o.starts_at) - from) / span) * 100
                const right = Math.min(1, (Date.parse(o.ends_at) - from) / span) * 100
                return <span key={i} className={`timeline-bar ${o.block_id ? 'is-block' : ''}`} style={{ left: `${left}%`, width: `${Math.max(0.8, right - left)}%` }} />
              })}
            </div>
          </VStack>
        )
      })}
    </VStack>
  )
}
