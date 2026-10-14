import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Phone } from 'lucide-react'
import { useParams } from 'react-router'
import { AlertDialog } from '@astryxdesign/core/AlertDialog'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { Card } from '@astryxdesign/core/Card'
import { Divider } from '@astryxdesign/core/Divider'
import { Heading } from '@astryxdesign/core/Heading'
import { HStack } from '@astryxdesign/core/HStack'
import { Icon } from '@astryxdesign/core/Icon'
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList'
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl'
import { StackItem } from '@astryxdesign/core/Stack'
import { Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import { useToast } from '@astryxdesign/core/Toast'
import type { Order } from '@/api/types'
import { useShop, useSlug } from '@/app/shop-context'
import { PageHeader } from '@/components/PageHeader'
import { QueryState } from '@/components/QueryState'
import { Sheet, useSheet } from '@/components/Sheet'
import { errorMessage } from '@/lib/errors'
import { dateTime, fromLocalInput, money, qty, time, toLocalInput } from '@/lib/format'
import { NativeField, parseMoney } from './fields'
import { useOwner } from './owner-context'
import { StatusBadge } from './parts'

export function OwnerOrderPage() {
  const { orderId = '' } = useParams()
  const { api, key } = useOwner()
  const slug = useSlug()
  const q = useQuery({ queryKey: key('order', orderId), queryFn: () => api.order(orderId) })
  return (
    <VStack>
      <PageHeader title={q.data ? `Заказ №${q.data.number}` : 'Заказ'} back={`/s/${slug}/owner/`} />
      <QueryState query={q}>{(o) => <Details order={o} />}</QueryState>
    </VStack>
  )
}

function Details({ order }: { order: Order }) {
  const shop = useShop()
  const { api, key } = useOwner()
  const qc = useQueryClient()
  const showToast = useToast()
  const tz = shop.tenant.timezone
  const cur = order.currency
  const complete = useSheet('complete')
  const pay = useSheet('payment')
  const move = useSheet('move')
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [finalAmount, setFinalAmount] = useState(() => String((order.final_amount_cents ?? order.subtotal_cents) / 100))
  const [payAmount, setPayAmount] = useState(() => String(Math.max(0, (order.final_amount_cents ?? order.subtotal_cents) - order.paid_cents) / 100))
  const [method, setMethod] = useState('card')
  const [kind, setKind] = useState<'payment' | 'refund'>('payment')
  const [newPickup, setNewPickup] = useState(() => toLocalInput(order.pickup_at, tz))
  const [keys] = useState(() => ({ pay: crypto.randomUUID(), move: crypto.randomUUID() }))

  const done = (msg: string) => (o: Order) => {
    qc.setQueryData(key('order', order.id), o)
    qc.invalidateQueries({ queryKey: key('schedule') })
    qc.invalidateQueries({ queryKey: key('stats') })
    showToast({ body: msg })
  }
  const status = useMutation({ mutationFn: (a: 'arrived' | 'ready' | 'no_show') => api.status(order.id, a), onSuccess: (o, a) => done(a === 'arrived' ? 'Отмечен визит' : a === 'ready' ? 'Заказ собран' : 'Отмечено: не забрал')(o) })
  const completeM = useMutation({
    mutationFn: async () => {
      const cents = parseMoney(finalAmount)
      if (cents === null) throw new Error('invalid_amount')
      let o = await api.status(order.id, 'completed', cents)
      const due = cents - o.paid_cents
      if (due > 0) o = await api.payment(order.id, due, method, 'payment', keys.pay)
      return o
    },
    onSuccess: (o) => { done('Заказ выдан')(o); complete.close() },
  })
  const payM = useMutation({
    mutationFn: () => { const c = parseMoney(payAmount); if (!c) throw new Error('invalid_amount'); return api.payment(order.id, c, method, kind, keys.pay) },
    onSuccess: (o) => { done(kind === 'payment' ? 'Оплата записана' : 'Возврат записан')(o); pay.close() },
  })
  const moveM = useMutation({ mutationFn: () => api.reschedule(order.id, fromLocalInput(newPickup, tz), keys.move), onSuccess: (o) => { done('Время изменено')(o); move.close() } })
  const cancelM = useMutation({ mutationFn: () => api.cancel(order.id, 'отменён магазином'), onSuccess: (o) => { done('Заказ отменён')(o); setConfirmCancel(false) } })

  const active = order.status === 'confirmed' || order.status === 'ready'
  const [openedAt] = useState(() => Date.now())
  const mutError = [status, completeM, payM, moveM, cancelM].find((m) => m.isError)?.error
  const due = (order.final_amount_cents ?? order.subtotal_cents) - order.paid_cents

  return (
    <VStack gap={4} paddingInline={4} paddingBlockEnd={6}>
      <Card>
        <VStack gap={2}>
          <HStack gap={2} vAlign="center"><StackItem size="fill"><Heading level={2}>{dateTime(order.pickup_at, tz)}</Heading></StackItem>
            <StatusBadge status={order.status} isDemo={order.is_demo} /></HStack>
          <Text>{order.customer_name} · {order.customer_phone}</Text>
          {order.note ? <Text type="supporting">«{order.note}»</Text> : null}
        </VStack>
      </Card>
      {mutError ? <Banner status="error" title={errorMessage(mutError)} /> : null}

      {active ? (
        <VStack gap={2}>
          {order.status === 'confirmed' ? <Button label="Собран — можно забирать" variant="primary" size="lg" width="100%" isLoading={status.isPending} onClick={() => status.mutate('ready')} /> : null}
          <Button label="Выдать заказ" variant={order.status === 'ready' ? 'primary' : 'secondary'} size="lg" width="100%" onClick={() => complete.open()} />
          <HStack gap={2}>
            <StackItem size="fill"><Button label={order.arrived_at ? `Пришёл в ${time(order.arrived_at, tz)}` : 'Покупатель пришёл'} width="100%" isDisabled={!!order.arrived_at} onClick={() => status.mutate('arrived')} /></StackItem>
            <StackItem size="fill"><Button label="Перенести" width="100%" onClick={() => move.open()} /></StackItem>
          </HStack>
        </VStack>
      ) : null}

      <VStack gap={2}>
        <Heading level={3}>Состав</Heading>
        <ul className="cart-lines">
          {order.items.map((i) => (
            <li key={i.product_id} className="cart-line"><HStack gap={2}>
              <StackItem size="fill"><Text>{i.name}</Text><Text type="supporting"> · {qty(Number(i.quantity), i.unit)} × {money(i.unit_price_cents, cur)}</Text></StackItem>
              <Text hasTabularNumbers>{money(i.line_total_cents, cur)}</Text></HStack></li>
          ))}
        </ul>
        <MetadataList>
          <MetadataListItem label="Сумма по заказу">{money(order.subtotal_cents, cur)}</MetadataListItem>
          {order.final_amount_cents != null ? <MetadataListItem label="После взвешивания">{money(order.final_amount_cents, cur)}</MetadataListItem> : null}
          <MetadataListItem label="Получено">{money(order.paid_cents, cur)}</MetadataListItem>
        </MetadataList>
        <Button label="Оплата или возврат" onClick={() => { setKind('payment'); setPayAmount(String(Math.max(0, due) / 100)); pay.open() }} />
      </VStack>

      {order.preparation.length ? (
        <VStack gap={1}>
          <Heading level={3}>Подготовка</Heading>
          {order.preparation.map((p, i) => <Text key={i} type="supporting">{p.resource_name}: {dateTime(p.starts_at, tz)} → {time(p.ends_at, tz)}</Text>)}
        </VStack>
      ) : null}

      <Divider />
      <Button label={`Позвонить ${order.customer_phone}`} variant="ghost" icon={<Icon icon={Phone} />} href={`tel:${order.customer_phone}`} />
      {order.status === 'confirmed' && openedAt > Date.parse(order.pickup_at) ? <Button label="Не пришёл за заказом" variant="ghost" onClick={() => status.mutate('no_show')} /> : null}
      {active ? <Button label="Отменить заказ" variant="destructive" onClick={() => setConfirmCancel(true)} /> : null}

      <Sheet isOpen={complete.isOpen} onClose={complete.close} title="Выдача заказа" description="Укажите сумму после взвешивания; недостающая оплата будет записана."
        footer={<Button label="Выдать" variant="primary" size="lg" width="100%" isLoading={completeM.isPending} onClick={() => completeM.mutate()} />}>
        <VStack gap={3}>
          <NativeField label={`Итог, ${cur}`} inputMode="decimal" value={finalAmount} onChange={(e) => setFinalAmount(e.target.value)} />
          <SegmentedControl label="Способ оплаты" value={method} onChange={setMethod} layout="fill">
            <SegmentedControlItem value="card" label="Карта" /><SegmentedControlItem value="cash" label="Наличные" /><SegmentedControlItem value="transfer" label="Перевод" />
          </SegmentedControl>
          {completeM.isError ? <Text color="accent" role="alert">{errorMessage(completeM.error)}</Text> : null}
        </VStack>
      </Sheet>
      <Sheet isOpen={pay.isOpen} onClose={pay.close} title="Оплата" footer={<Button label={kind === 'payment' ? 'Записать оплату' : 'Записать возврат'} variant="primary" size="lg" width="100%" isLoading={payM.isPending} onClick={() => payM.mutate()} />}>
        <VStack gap={3}>
          <SegmentedControl label="Тип" value={kind} onChange={(v) => setKind(v as 'payment' | 'refund')} layout="fill">
            <SegmentedControlItem value="payment" label="Оплата" /><SegmentedControlItem value="refund" label="Возврат" />
          </SegmentedControl>
          <NativeField label={`Сумма, ${cur}`} inputMode="decimal" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
          <SegmentedControl label="Способ" value={method} onChange={setMethod} layout="fill">
            <SegmentedControlItem value="card" label="Карта" /><SegmentedControlItem value="cash" label="Наличные" /><SegmentedControlItem value="transfer" label="Перевод" />
          </SegmentedControl>
          {payM.isError ? <Text color="accent" role="alert">{errorMessage(payM.error)}</Text> : null}
        </VStack>
      </Sheet>
      <Sheet isOpen={move.isOpen} onClose={move.close} title="Перенос выдачи" description={`Время магазина (${tz}). Если ресурс занят, заказ останется на прежнем времени.`}
        footer={<Button label="Перенести" variant="primary" size="lg" width="100%" isLoading={moveM.isPending} onClick={() => moveM.mutate()} />}>
        <VStack gap={3}>
          <NativeField label="Новое время" type="datetime-local" step={300} value={newPickup} onChange={(e) => setNewPickup(e.target.value)} />
          {moveM.isError ? <Text color="accent" role="alert">{errorMessage(moveM.error)}</Text> : null}
        </VStack>
      </Sheet>
      <AlertDialog isOpen={confirmCancel} onOpenChange={setConfirmCancel} title={`Отменить заказ №${order.number}?`} description="Ресурсы освободятся. Покупатель увидит отмену по своей ссылке."
        actionLabel="Отменить заказ" cancelLabel="Назад" isActionLoading={cancelM.isPending} onAction={() => cancelM.mutate()} />
    </VStack>
  )
}
