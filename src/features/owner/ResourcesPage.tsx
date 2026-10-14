import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Lock, Trash2 } from 'lucide-react'
import { Button } from '@astryxdesign/core/Button'
import { Heading } from '@astryxdesign/core/Heading'
import { Icon } from '@astryxdesign/core/Icon'
import { IconButton } from '@astryxdesign/core/IconButton'
import { Item } from '@astryxdesign/core/Item'
import { List } from '@astryxdesign/core/List'
import { Selector } from '@astryxdesign/core/Selector'
import { Text } from '@astryxdesign/core/Text'
import { TextInput } from '@astryxdesign/core/TextInput'
import { VStack } from '@astryxdesign/core/VStack'
import { useToast } from '@astryxdesign/core/Toast'
import { useShop } from '@/app/shop-context'
import { PageHeader } from '@/components/PageHeader'
import { QueryState } from '@/components/QueryState'
import { Sheet, useSheet } from '@/components/Sheet'
import { errorMessage } from '@/lib/errors'
import { addDays, dateTime, fromLocalInput, localToday, toLocalInput } from '@/lib/format'
import { NativeField } from './fields'
import { useOwner } from './owner-context'
import { ResourceTimeline } from './parts'

export function ResourcesPage() {
  const { api, key } = useOwner()
  const shop = useShop()
  const tz = shop.tenant.timezone
  const qc = useQueryClient()
  const showToast = useToast()
  const today = localToday(tz)
  const sheet = useSheet('block')
  const q = useQuery({ queryKey: key('schedule', today, addDays(today, 13)), queryFn: () => api.schedule(today, addDays(today, 13)) })
  const bounds = useQuery({ queryKey: key('bounds', today), queryFn: () => api.bounds('today') })
  const [resource, setResource] = useState('')
  const [from, setFrom] = useState(() => toLocalInput(new Date(Date.now() + 3600_000).toISOString(), tz).slice(0, 14) + '00')
  const [to, setTo] = useState(() => toLocalInput(new Date(Date.now() + 3 * 3600_000).toISOString(), tz).slice(0, 14) + '00')
  const [reason, setReason] = useState('')
  const [idem, setIdem] = useState(() => crypto.randomUUID())
  const refresh = () => qc.invalidateQueries({ queryKey: key('schedule') })
  const create = useMutation({
    mutationFn: () => api.createBlock(resource, fromLocalInput(from, tz), fromLocalInput(to, tz), reason, idem),
    onSuccess: () => { refresh(); setIdem(crypto.randomUUID()); setReason(''); sheet.close(); showToast({ body: 'Ресурс заблокирован' }) },
  })
  const remove = useMutation({ mutationFn: (id: string) => api.deleteBlock(id), onSuccess: () => { refresh(); showToast({ body: 'Блокировка снята' }) } })

  return (
    <VStack>
      <PageHeader title="Ресурсы" end={<Button label="Блокировка" size="sm" icon={<Icon icon={Lock} />} onClick={() => sheet.open()} />} />
      <QueryState query={q}>
        {(s) => (
          <VStack gap={5} paddingInline={4} paddingBlockEnd={6}>
            {bounds.data ? <ResourceTimeline schedule={s} dayStart={bounds.data.from_ts} dayEnd={bounds.data.to_ts} tz={tz} /> : null}
            <VStack gap={2}>
              <Heading level={3}>Блокировки на 2 недели</Heading>
              {s.blocks.length ? (
                <List hasDividers density="compact">
                  {s.blocks.map((b) => (
                    <Item key={b.id} as="li" label={b.resource_name} description={`${dateTime(b.starts_at, tz)} → ${dateTime(b.ends_at, tz)}${b.reason ? ` · ${b.reason}` : ''}`}
                      endContent={<IconButton label="Снять блокировку" variant="ghost" icon={<Icon icon={Trash2} />} isLoading={remove.isPending && remove.variables === b.id} onClick={() => remove.mutate(b.id)} />} />
                  ))}
                </List>
              ) : <Text type="supporting">Блокировок нет. Блокировка занимает ресурс так же, как заказ: в это время его не предложат покупателям.</Text>}
            </VStack>
          </VStack>
        )}
      </QueryState>
      <Sheet isOpen={sheet.isOpen} onClose={sheet.close} title="Заблокировать ресурс" description={`Время магазина (${tz}). Нельзя заблокировать время, занятое заказами.`}
        footer={<VStack gap={2}>
          {create.isError ? <Text color="accent" role="alert">{errorMessage(create.error)}</Text> : null}
          <Button label="Заблокировать" variant="primary" size="lg" width="100%" isDisabled={!resource || from >= to} isLoading={create.isPending} onClick={() => create.mutate()} />
        </VStack>}>
        <VStack gap={3}>
          <Selector label="Ресурс" value={resource} onChange={setResource} placeholder="Выберите"
            options={(q.data?.resources ?? []).filter((r) => r.is_active).map((r) => ({ value: r.id, label: r.name }))} />
          <NativeField label="С" type="datetime-local" step={300} value={from} onChange={(e) => setFrom(e.target.value)} />
          <NativeField label="До" type="datetime-local" step={300} value={to} onChange={(e) => setTo(e.target.value)} />
          <TextInput label="Причина" value={reason} onChange={setReason} isOptional placeholder="Санобработка, ремонт…" />
        </VStack>
      </Sheet>
    </VStack>
  )
}
