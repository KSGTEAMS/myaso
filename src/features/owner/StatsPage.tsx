import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Card } from '@astryxdesign/core/Card'
import { Grid } from '@astryxdesign/core/Grid'
import { Heading } from '@astryxdesign/core/Heading'
import { HStack } from '@astryxdesign/core/HStack'
import { ProgressBar } from '@astryxdesign/core/ProgressBar'
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl'
import { StackItem } from '@astryxdesign/core/Stack'
import { Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import type { Period } from '@/api/owner'
import { PageHeader } from '@/components/PageHeader'
import { QueryState } from '@/components/QueryState'
import { dayLabel, money } from '@/lib/format'
import { useOwner } from './owner-context'

const PERIODS: Array<[Period, string]> = [['today', 'Сегодня'], ['week', 'Неделя'], ['last7', '7 дней'], ['month', 'Месяц']]

/** All numbers are computed in SQL (owner_stats) for the same bounds the assistant uses. */
export function StatsPage() {
  const { api, key } = useOwner()
  const [period, setPeriod] = useState<Period>('today')
  const q = useQuery({ queryKey: key('stats', period), queryFn: () => api.stats(period), refetchInterval: 60_000 })
  return (
    <VStack>
      <PageHeader title="Статистика" />
      <VStack gap={4} paddingInline={4} paddingBlockEnd={6}>
        <SegmentedControl label="Период" value={period} onChange={(v) => setPeriod(v as Period)} layout="fill">
          {PERIODS.map(([v, l]) => <SegmentedControlItem key={v} value={v} label={l} />)}
        </SegmentedControl>
        <QueryState query={q}>
          {(s) => {
            const f = dayLabel(s.bounds.from_date)
            const t = dayLabel(s.bounds.to_date)
            return (
              <VStack gap={4}>
                <Text type="supporting">
                  {s.bounds.from_date === s.bounds.to_date ? `${f.day} ${f.month}` : `${f.day} ${f.month} — ${t.day} ${t.month}`} · время магазина ({s.bounds.timezone})
                </Text>
                <Grid columns={2} gap={3}>
                  <Metric label="Получено оплат" value={money(s.payments_received.net_cents, s.currency)}
                    note={`${s.payments_received.count} платеж.${s.payments_received.refunds_cents ? ` · возвраты ${money(s.payments_received.refunds_cents, s.currency)}` : ''}`} />
                  <Metric label="Выдано заказов" value={String(s.completed_orders.count)} note={`на ${money(s.completed_orders.value_cents, s.currency)}`} />
                  <Metric label="Визиты за заказами" value={String(s.visits)} note={`из ${s.scheduled_pickups} запланированных`} />
                  <Metric label="Ожидается к выдаче" value={money(s.expected_pickups.value_cents, s.currency)} note={`${s.expected_pickups.count} заказ. · это не выручка`} />
                </Grid>
                <HStack gap={4}>
                  <Text type="supporting">Отмены: {s.cancelled}</Text>
                  <Text type="supporting">Не забрали: {s.no_show}</Text>
                </HStack>
                <VStack gap={2}>
                  <Heading level={3}>Загрузка ресурсов</Heading>
                  {s.resource_load.map((r) => {
                    const pct = r.period_minutes ? Math.min(100, Math.round((r.busy_minutes / r.period_minutes) * 100)) : 0
                    return (
                      <VStack key={r.resource_id} gap={1}>
                        <HStack gap={2}><StackItem size="fill"><Text type="supporting">{r.name}</Text></StackItem><Text type="supporting" hasTabularNumbers>{pct}%</Text></HStack>
                        <ProgressBar label={`Загрузка: ${r.name}`} value={pct} isLabelHidden />
                      </VStack>
                    )
                  })}
                </VStack>
              </VStack>
            )
          }}
        </QueryState>
      </VStack>
    </VStack>
  )
}

function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <Card padding={3}>
      <VStack gap={1}>
        <Text type="supporting">{label}</Text>
        <Heading level={2}>{value}</Heading>
        <Text type="supporting" size="2xs">{note}</Text>
      </VStack>
    </Card>
  )
}
