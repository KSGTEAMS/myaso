import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, MapPin, Phone } from 'lucide-react'
import { useLocation, useParams } from 'react-router'
import { AlertDialog } from '@astryxdesign/core/AlertDialog'
import { Badge } from '@astryxdesign/core/Badge'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { Card } from '@astryxdesign/core/Card'
import { Divider } from '@astryxdesign/core/Divider'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { Heading } from '@astryxdesign/core/Heading'
import { HStack } from '@astryxdesign/core/HStack'
import { Icon } from '@astryxdesign/core/Icon'
import { StackItem } from '@astryxdesign/core/Stack'
import { Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import { useToast } from '@astryxdesign/core/Toast'
import { publicApi } from '@/api/public'
import type { Order } from '@/api/types'
import { useShop, useSlug } from '@/app/shop-context'
import { PageHeader } from '@/components/PageHeader'
import { QueryState } from '@/components/QueryState'
import { Sheet, useSheet } from '@/components/Sheet'
import { SlotPicker } from '@/components/SlotPicker'
import { errorCode, errorMessage } from '@/lib/errors'
import { STATUS_LABEL, dateTime, money, qty } from '@/lib/format'
import { forgetOrder, orderLink, rememberOrder, tokenFor } from '@/lib/my-orders'
import { Reminders } from './Reminders'

/** The token comes from the personal link (#t=...) or from this device. */
function useOrderToken(slug: string, orderId: string): string | null {
  const [token] = useState(() => {
    const fromHash = new URLSearchParams(location.hash.slice(1)).get('t')
    return fromHash ?? tokenFor(slug, orderId)
  })
  useEffect(() => {
    if (location.hash) history.replaceState(history.state, '', location.pathname + location.search)
  }, [])
  return token
}

export function OrderPage() {
  const { orderId = '' } = useParams()
  const slug = useSlug()
  const token = useOrderToken(slug, orderId)
  const q = useQuery({
    queryKey: ['order', orderId],
    queryFn: () => publicApi.get(orderId, token!),
    enabled: !!token,
    refetchInterval: 60_000,
  })
  useEffect(() => {
    if (q.data && token) rememberOrder(slug, { id: q.data.id, token, number: q.data.number, pickup_at: q.data.pickup_at, created_at: q.data.created_at })
  }, [q.data, token, slug])

  if (!token) {
    return (
      <VStack><PageHeader title="Заказ" back={`/s/${slug}/orders`} />
        <EmptyState title="Нет доступа к заказу" description="Откройте личную ссылку на заказ — она сохраняется на устройстве, где он был оформлен."
          actions={<Button label="В каталог" href={`/s/${slug}/`} />} />
      </VStack>
    )
  }
  return (
    <VStack>
      <PageHeader title={q.data ? `Заказ №${q.data.number}` : 'Заказ'} back={`/s/${slug}/orders`} />
      <QueryState query={q}>{(order) => <OrderDetails order={order} token={token} />}</QueryState>
    </VStack>
  )
}

function OrderDetails({ order, token }: { order: Order; token: string }) {
  const shop = useShop()
  const slug = useSlug()
  const tz = shop.tenant.timezone
  const qc = useQueryClient()
  const loc = useLocation()
  const showToast = useToast()
  const resched = useSheet('reschedule')
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [newPickup, setNewPickup] = useState<string | null>(null)
  const [key] = useState(() => crypto.randomUUID())
  const justPlaced = (loc.state as { justPlaced?: boolean } | null)?.justPlaced

  const reschedule = useMutation({
    mutationFn: () => publicApi.reschedule(order.id, token, newPickup!, key),
    onSuccess: (o) => { qc.setQueryData(['order', order.id], o); resched.close(); showToast({ body: `Перенесли на ${dateTime(o.pickup_at, tz)}` }) },
    onError: (e) => { if (errorCode(e) === 'slot_taken') qc.invalidateQueries({ queryKey: ['slots', slug] }) },
  })
  const cancel = useMutation({
    mutationFn: () => publicApi.cancel(order.id, token),
    onSuccess: (o) => { qc.setQueryData(['order', order.id], o); setConfirmCancel(false); showToast({ body: 'Заказ отменён' }) },
  })
  const share = async () => {
    const url = orderLink(slug, order.id, token)
    try {
      if (navigator.share) await navigator.share({ title: `Заказ №${order.number}`, url })
      else { await navigator.clipboard.writeText(url); showToast({ body: 'Ссылка скопирована' }) }
    } catch { /* user dismissed */ }
  }
  const lines = order.items.map((i) => ({ product_id: i.product_id, quantity: Number(i.quantity) }))
  const active = order.status === 'confirmed' || order.status === 'ready'

  return (
    <VStack gap={4} paddingInline={4} paddingBlockEnd={6}>
      {justPlaced ? <Banner status="success" title="Заказ принят" description="Мы начнём готовить его к выбранному времени." /> : null}
      {order.is_demo ? <Badge label="Демо-заказ" variant="warning" /> : null}
      <Card>
        <VStack gap={2}>
          <HStack gap={2} vAlign="center">
            <StackItem size="fill"><Text type="supporting">Выдача</Text></StackItem>
            <Badge label={STATUS_LABEL[order.status] ?? order.status} variant={order.status === 'cancelled' ? 'error' : order.status === 'ready' ? 'success' : 'info'} />
          </HStack>
          <Heading level={2} type="display-3">{dateTime(order.pickup_at, tz)}</Heading>
          <HStack gap={2} vAlign="center"><Icon icon={MapPin} size="sm" color="secondary" />
            <Text type="supporting">{shop.tenant.profile.contacts?.address}</Text></HStack>
          {order.status === 'ready' ? <Text color="accent">Заказ собран — можно забирать.</Text> : null}
        </VStack>
      </Card>

      <VStack gap={2}>
        <Heading level={3}>Состав</Heading>
        <ul className="cart-lines">
          {order.items.map((i) => (
            <li key={i.product_id} className="cart-line">
              <HStack gap={2}>
                <StackItem size="fill"><Text>{i.name}</Text><Text type="supporting"> · {qty(Number(i.quantity), i.unit)}</Text></StackItem>
                <Text hasTabularNumbers>{money(i.line_total_cents, order.currency)}</Text>
              </HStack>
            </li>
          ))}
        </ul>
        <HStack gap={2}>
          <StackItem size="fill"><Text weight="semibold">{order.final_amount_cents != null ? 'К оплате' : 'Ориентировочно'}</Text></StackItem>
          <Text weight="semibold" hasTabularNumbers>{money(order.final_amount_cents ?? order.subtotal_cents, order.currency)}</Text>
        </HStack>
        {order.paid_cents > 0 ? <Text type="supporting">Оплачено: {money(order.paid_cents, order.currency)}</Text> : null}
      </VStack>

      {active ? (
        <>
          <Divider />
          <Reminders slug={slug} orderId={order.id} token={token} />
          <Divider />
          {order.can_change ? (
            <VStack gap={2}>
              <Button label="Перенести время" width="100%" onClick={() => { setNewPickup(null); resched.open() }} />
              <Button label="Отменить заказ" variant="destructive" width="100%" onClick={() => setConfirmCancel(true)} />
              <Text type="supporting">Изменить можно до {dateTime(order.change_deadline, tz)}.</Text>
            </VStack>
          ) : (
            <Text type="supporting">Изменить заказ онлайн уже нельзя — позвоните в магазин.</Text>
          )}
        </>
      ) : null}
      {shop.tenant.profile.contacts?.phone ? (
        <Button label={`Позвонить ${shop.tenant.profile.contacts.phone}`} variant="ghost" icon={<Icon icon={Phone} />} href={`tel:${shop.tenant.profile.contacts.phone}`} />
      ) : null}
      <Button label="Ссылка на заказ" variant="ghost" icon={<Icon icon={Copy} />} onClick={share} />
      {!active ? <Button label="Убрать из списка на этом устройстве" variant="ghost" onClick={() => { forgetOrder(slug, order.id); history.back() }} /> : null}

      <Sheet isOpen={resched.isOpen} onClose={resched.close} title="Новое время выдачи" description="Пока вы не подтвердите перенос, заказ остаётся на прежнем времени."
        footer={<VStack gap={2}>
          {reschedule.isError ? <Text color="accent" role="alert">{errorMessage(reschedule.error)}</Text> : null}
          <Button label={newPickup ? `Перенести на ${dateTime(newPickup, tz)}` : 'Выберите время'} variant="primary" size="lg" width="100%"
            isDisabled={!newPickup} isLoading={reschedule.isPending} onClick={() => reschedule.mutate()} />
        </VStack>}>
        <SlotPicker slug={slug} lines={lines} value={newPickup} onChange={setNewPickup} exclude={order.pickup_at} />
      </Sheet>
      <AlertDialog isOpen={confirmCancel} onOpenChange={setConfirmCancel} title={`Отменить заказ №${order.number}?`}
        description="Время освободится для других покупателей. Отменить отмену будет нельзя." actionLabel="Отменить заказ" cancelLabel="Не отменять"
        isActionLoading={cancel.isPending} onAction={() => cancel.mutate()} />
      {cancel.isError ? <Text color="accent" role="alert">{errorMessage(cancel.error)}</Text> : null}
    </VStack>
  )
}
