import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { Button } from '@astryxdesign/core/Button'
import { HStack } from '@astryxdesign/core/HStack'
import { StackItem } from '@astryxdesign/core/Stack'
import { Text } from '@astryxdesign/core/Text'
import { TextInput } from '@astryxdesign/core/TextInput'
import { VStack } from '@astryxdesign/core/VStack'
import { useShop, useSlug } from '@/app/shop-context'
import { QtyStepper } from '@/components/QtyStepper'
import { Sheet } from '@/components/Sheet'
import { errorMessage } from '@/lib/errors'
import { fromLocalInput, money, toLocalInput } from '@/lib/format'
import { NativeField } from './fields'
import { useOwner } from './owner-context'

/** Order taken by phone. Same SQL core as online orders (prices, resources). */
export function NewOrderSheet({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const shop = useShop()
  const slug = useSlug()
  const { api, key } = useOwner()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const tz = shop.tenant.timezone
  const [lines, setLines] = useState<Record<string, number>>({})
  const [pickup, setPickup] = useState(() => toLocalInput(new Date(Date.now() + 3 * 3600_000).toISOString(), tz).slice(0, 14) + '00')
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [idem, setIdem] = useState(() => crypto.randomUUID())
  const items = Object.entries(lines).filter(([, q]) => q > 0).map(([product_id, quantity]) => ({ product_id, quantity }))
  const total = items.reduce((s, i) => s + Math.round((shop.products.find((p) => p.id === i.product_id)?.price_cents ?? 0) * i.quantity), 0)
  const m = useMutation({
    mutationFn: () => api.createOrder(items, fromLocalInput(pickup, tz), { name, phone }, idem),
    onSuccess: (o) => {
      qc.invalidateQueries({ queryKey: key() })
      setLines({}); setName(''); setPhone(''); setIdem(crypto.randomUUID())
      onClose()
      navigate(`/s/${slug}/owner/orders/${o.id}`)
    },
  })
  return (
    <Sheet isOpen={isOpen} onClose={onClose} title="Заказ по телефону" description={`Время — ${tz}`}
      footer={<VStack gap={2}>
        {m.isError ? <Text color="accent" role="alert">{errorMessage(m.error)}</Text> : null}
        <Button label={items.length ? `Создать · ${money(total, shop.tenant.currency)}` : 'Добавьте товары'} variant="primary" size="lg" width="100%"
          isDisabled={!items.length || name.trim().length < 2 || phone.replace(/\D/g, '').length < 10} isLoading={m.isPending} onClick={() => m.mutate()} />
      </VStack>}>
      <VStack gap={3}>
        <NativeField label="Выдача" type="datetime-local" value={pickup} onChange={(e) => setPickup(e.target.value)} step={300} />
        <TextInput label="Имя покупателя" value={name} onChange={setName} />
        <TextInput label="Телефон" value={phone} onChange={setPhone} placeholder="+7…" />
        <ul className="cart-lines" aria-label="Товары">
          {shop.products.map((p) => (
            <li key={p.id} className="cart-line">
              <HStack gap={2} vAlign="center">
                <StackItem size="fill"><Text>{p.name}</Text></StackItem>
                <QtyStepper product={p} value={lines[p.id] ?? 0} onChange={(q) => setLines((l) => ({ ...l, [p.id]: q }))} size="sm" />
              </HStack>
            </li>
          ))}
        </ul>
      </VStack>
    </Sheet>
  )
}
