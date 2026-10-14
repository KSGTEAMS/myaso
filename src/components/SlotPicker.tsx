import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { Skeleton } from '@astryxdesign/core/Skeleton'
import { Text } from '@astryxdesign/core/Text'
import { ToggleButton } from '@astryxdesign/core/ToggleButton'
import { VStack } from '@astryxdesign/core/VStack'
import { publicApi } from '@/api/public'
import type { CartLine, SlotsResponse } from '@/api/types'
import { errorMessage } from '@/lib/errors'
import { addDays, dayLabel, minutesLabel } from '@/lib/format'

export const slotsKey = (slug: string, lines: CartLine[], from: string | null) => ['slots', slug, JSON.stringify(lines), from] as const

/** Day strip + time grid. Availability always comes from the server. */
export function SlotPicker({ slug, lines, value, onChange, exclude }:
  { slug: string; lines: CartLine[]; value: string | null; onChange: (pickupAt: string | null) => void; exclude?: string }) {
  const [from, setFrom] = useState<string | null>(null)
  const q = useQuery({
    queryKey: slotsKey(slug, lines, from),
    queryFn: ({ signal }) => publicApi.slots(slug, lines, from ?? undefined, from ? addDays(from, 6) : undefined, signal),
    enabled: lines.length > 0,
    staleTime: 20_000,
    refetchInterval: 60_000,
  })
  const days = useMemo(() => groupByDay(q.data), [q.data])
  const [day, setDay] = useState<string | null>(null)
  const activeDay = day && days.has(day) ? day : days.keys().next().value ?? null

  // A previously chosen moment that is no longer offered gets deselected.
  useEffect(() => {
    if (value && q.data && !q.data.slots.some((s) => s.pickup_at === value)) onChange(null)
  }, [q.data, value, onChange])

  if (q.isPending) return <VStack gap={2} aria-busy="true" aria-label="Загрузка времени"><Skeleton height={64} /><Skeleton height={96} index={1} /></VStack>
  if (q.isError) return <Banner status="error" title="Не удалось получить время выдачи" description={errorMessage(q.error)} endContent={<Button label="Повторить" size="sm" onClick={() => q.refetch()} />} />
  const data = q.data
  const prepLong = data.groups.find((g) => g.minutes >= 180)
  if (!data.slots.length) {
    return (
      <EmptyState isCompact title="Нет свободного времени" description={from ? 'На эту неделю мест нет.' : 'В ближайшие дни мест нет — попробуйте позже или уберите товары с долгой подготовкой.'}
        actions={<Button label={from ? 'Следующая неделя' : 'Показать следующую неделю'} onClick={() => setFrom(addDays(data.to, 1))} />} />
    )
  }
  const slots = activeDay ? days.get(activeDay)! : []
  return (
    <VStack gap={3}>
      {prepLong ? <Text type="supporting">{prepLong.prep_profile}: {minutesLabel(prepLong.minutes)} — поэтому ближайшее время позже обычного.</Text> : null}
      <div className="day-strip" role="radiogroup" aria-label="День выдачи">
        {[...days.keys()].map((d) => {
          const l = dayLabel(d)
          return (
            <ToggleButton key={d} label={`${l.weekday}, ${l.day} ${l.month}`} isPressed={d === activeDay} onPressedChange={() => setDay(d)}>
              <span className="day-chip"><span>{l.weekday}</span><strong>{l.day}</strong><span>{l.month}</span></span>
            </ToggleButton>
          )
        })}
      </div>
      <div className="slot-grid" role="radiogroup" aria-label="Время выдачи">
        {slots.map((s) => (
          <ToggleButton key={s.pickup_at} label={s.local_time} isPressed={s.pickup_at === value} isDisabled={s.pickup_at === exclude}
            onPressedChange={(p) => onChange(p ? s.pickup_at : null)} />
        ))}
      </div>
      <Button label="Позже" variant="ghost" size="sm" onClick={() => setFrom(addDays(data.to, 1))} />
    </VStack>
  )
}

function groupByDay(data?: SlotsResponse) {
  const m = new Map<string, SlotsResponse['slots']>()
  for (const s of data?.slots ?? []) m.set(s.local_date, [...(m.get(s.local_date) ?? []), s])
  return m
}
