import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'
import { useNavigate } from 'react-router'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { Divider } from '@astryxdesign/core/Divider'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { Heading } from '@astryxdesign/core/Heading'
import { HStack } from '@astryxdesign/core/HStack'
import { Icon } from '@astryxdesign/core/Icon'
import { IconButton } from '@astryxdesign/core/IconButton'
import { StackItem } from '@astryxdesign/core/Stack'
import { Text } from '@astryxdesign/core/Text'
import { TextArea } from '@astryxdesign/core/TextArea'
import { TextInput } from '@astryxdesign/core/TextInput'
import { VStack } from '@astryxdesign/core/VStack'
import { publicApi } from '@/api/public'
import { useShop, useSlug } from '@/app/shop-context'
import { PageHeader } from '@/components/PageHeader'
import { QtyStepper } from '@/components/QtyStepper'
import { SlotPicker } from '@/components/SlotPicker'
import { reconcileCart, useCart, cartStore } from '@/lib/cart'
import { ApiError, errorCode, errorMessage } from '@/lib/errors'
import { dateTime, money, qty } from '@/lib/format'
import { pendingCheckout, rememberOrder } from '@/lib/my-orders'
import { store } from '@/lib/store'

const contactStore = (slug: string) => store<{ name: string; phone: string }>(`contact:${slug}`, { name: '', phone: '' })

export function CartPage() {
  const shop = useShop()
  const slug = useSlug()
  const cart = useCart(slug)
  const navigate = useNavigate()
  const qc = useQueryClient()
  const tz = shop.tenant.timezone
  const contact = contactStore(slug).use()
  const [pickup, setPickup] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<{ code: string | null; message: string } | null>(null)
  const [touched, setTouched] = useState(false)

  // Drop lines that the shop no longer sells (catalog changed since adding).
  useEffect(() => {
    const ok = reconcileCart(cart.lines, shop.products)
    if (ok.length !== cart.lines.length) cartStore(slug).set(ok)
  }, [shop.products]) // eslint-disable-line react-hooks/exhaustive-deps

  const byId = useMemo(() => new Map(shop.products.map((p) => [p.id, p])), [shop.products])
  const total = cart.lines.reduce((s, l) => s + Math.round((byId.get(l.product_id)?.price_cents ?? 0) * l.quantity), 0)
  const hasWeighed = cart.lines.some((l) => byId.get(l.product_id)?.unit === 'kg')
  const phoneOk = /^\+?[\d\s()-]{10,20}$/.test(contact.phone.trim()) && contact.phone.replace(/\D/g, '').length >= 10
  const nameOk = contact.name.trim().length >= 2

  const submit = async () => {
    setTouched(true)
    if (!pickup || !nameOk || !phoneOk) return
    setSubmitting(true)
    setError(null)
    const customer = { name: contact.name.trim(), phone: contact.phone, note: note.trim() || undefined }
    const fingerprint = JSON.stringify([cart.lines, pickup, customer])
    // Same intent -> same idempotency key, even across reloads; a lost
    // response is retried safely and returns the same order and token.
    const pending = pendingCheckout(slug)
    const key = pending.get()?.fingerprint === fingerprint ? pending.get()!.key : crypto.randomUUID()
    pending.set({ key, fingerprint })
    try {
      const order = await publicApi.place({ slug, items: cart.lines, pickup_at: pickup, idempotency_key: key, customer })
      rememberOrder(slug, { id: order.id, token: order.access_token!, number: order.number, pickup_at: order.pickup_at, created_at: order.created_at })
      qc.setQueryData(['order', order.id], order)
      pending.set(null)
      cart.clear()
      navigate(`/s/${slug}/orders/${order.id}`, { replace: true, state: { justPlaced: true } })
    } catch (e) {
      const code = errorCode(e)
      setError({ code, message: errorMessage(e) })
      if (code === 'slot_taken' || code === 'slot_unavailable') {
        setPickup(null)
        pending.set(null)
        await qc.invalidateQueries({ queryKey: ['slots', slug] })
      }
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && code !== 'rate_limited') pending.set(null)
    } finally {
      setSubmitting(false)
    }
  }

  if (cart.count === 0) {
    return (
      <VStack>
        <PageHeader title="Корзина" />
        <EmptyState title="Корзина пуста" description="Выберите мясо в каталоге — мы подготовим заказ к удобному времени."
          actions={<Button label="В каталог" variant="primary" href={`/s/${slug}/`} />} />
      </VStack>
    )
  }

  return (
    <VStack gap={0}>
      <PageHeader title="Корзина" end={<Button label="Очистить" variant="ghost" size="sm" onClick={() => cart.clear()} />} />
      <VStack gap={5} paddingInline={4} paddingBlockEnd={6}>
        <ul className="cart-lines" aria-label="Состав заказа">
          {cart.lines.map((l) => {
            const p = byId.get(l.product_id)
            if (!p) return null
            return (
              <li key={l.product_id} className="cart-line">
                <VStack gap={1}>
                  <HStack gap={2} vAlign="start">
                    <StackItem size="fill"><Text type="label" weight="semibold">{p.name}</Text></StackItem>
                    <Text hasTabularNumbers>{money(Math.round(p.price_cents * l.quantity), shop.tenant.currency)}</Text>
                  </HStack>
                  <HStack gap={2} vAlign="center">
                    <StackItem size="fill"><Text type="supporting">{money(p.price_cents, shop.tenant.currency)} × {qty(l.quantity, p.unit)}</Text></StackItem>
                    <QtyStepper product={p} value={l.quantity} onChange={(q) => cart.setQuantity(p, q)} size="sm" />
                    <IconButton label={`Удалить ${p.name}`} variant="ghost" size="sm" icon={<Icon icon={Trash2} />} onClick={() => cart.setQuantity(p, 0)} />
                  </HStack>
                </VStack>
              </li>
            )
          })}
        </ul>
        <HStack gap={2} vAlign="center">
          <StackItem size="fill"><Text weight="semibold">{hasWeighed ? 'Ориентировочно' : 'Итого'}</Text></StackItem>
          <Heading level={2}>{money(total, shop.tenant.currency)}</Heading>
        </HStack>
        {hasWeighed ? <Text type="supporting">Весовой товар взвешиваем при выдаче — итог может немного отличаться. {shop.tenant.profile.payment_note}</Text> : null}

        <Divider />
        <VStack gap={3}>
          <Heading level={2}>Когда заберёте</Heading>
          <Text type="supporting">Самовывоз: {shop.tenant.profile.contacts?.address}. Время — по часовому поясу магазина.</Text>
          <SlotPicker slug={slug} lines={cart.lines} value={pickup} onChange={setPickup} />
          {touched && !pickup ? <Text color="accent" role="alert">Выберите время выдачи</Text> : null}
        </VStack>

        <Divider />
        <VStack gap={3}>
          <Heading level={2}>Контакты</Heading>
          <TextInput label="Имя" value={contact.name} autoComplete="name" isRequired
            onChange={(v) => contactStore(slug).set((c) => ({ ...c, name: v }))}
            status={touched && !nameOk ? { type: 'error', message: 'Укажите имя' } : undefined} />
          <TextInput label="Телефон" value={contact.phone} autoComplete="tel" isRequired placeholder="+7 900 000-00-00"
            description="Позвоним, только если что-то изменится"
            onChange={(v) => contactStore(slug).set((c) => ({ ...c, phone: v }))}
            status={touched && !phoneOk ? { type: 'error', message: 'Проверьте номер' } : undefined} />
          <TextArea label="Комментарий" value={note} onChange={setNote} isOptional rows={2} maxLength={500}
            placeholder="Например: нарезать стейками по 3 см" />
        </VStack>

        {error ? <Banner status="error" title={error.message}
          endContent={error.code === 'network' || error.code === 'internal_error' ? <Button label="Повторить" size="sm" onClick={submit} /> : undefined} /> : null}

        <Button label={pickup ? `Заказать к ${dateTime(pickup, tz)}` : 'Заказать'} variant="primary" size="lg" width="100%"
          isLoading={submitting} onClick={submit} />
        <Text type="supporting" justify="center">Без регистрации. Ссылка на заказ сохранится на этом устройстве.</Text>
      </VStack>
    </VStack>
  )
}
