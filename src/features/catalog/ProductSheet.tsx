import { useEffect, useState } from 'react'
import { Badge } from '@astryxdesign/core/Badge'
import { Button } from '@astryxdesign/core/Button'
import { HStack } from '@astryxdesign/core/HStack'
import { StackItem } from '@astryxdesign/core/Stack'
import { Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import { useShop, useSlug } from '@/app/shop-context'
import { Photo } from '@/components/Photo'
import { QtyStepper } from '@/components/QtyStepper'
import { Sheet } from '@/components/Sheet'
import { useCart } from '@/lib/cart'
import { minutesLabel, money, qty, unitLabel } from '@/lib/format'
import type { Product, Shop } from '@/api/types'

/** Long preparation is visible before ordering (e.g. smoking takes a day). */
export function prepHint(shop: Shop, p: Product): string | null {
  const prep = shop.prep[p.prep_profile_id]
  if (!prep || prep.base_minutes < 180) return null
  return `${prep.name.toLowerCase()} · ${minutesLabel(prep.base_minutes)}`
}

export function ProductSheet({ product, isOpen, onClose }: { product: Product | null; isOpen: boolean; onClose: () => void }) {
  const shop = useShop()
  const slug = useSlug()
  const cart = useCart(slug)
  const inCart = product ? cart.quantityOf(product.id) : 0
  const [q, setQ] = useState(0)
  useEffect(() => { if (product) setQ(inCart || product.min_qty) }, [product?.id, isOpen]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!product) return null
  const prep = shop.prep[product.prep_profile_id]
  const hint = prepHint(shop, product)
  return (
    <Sheet isOpen={isOpen} onClose={onClose} title={product.name}
      description={`${money(product.price_cents, shop.tenant.currency)} за ${unitLabel(product.unit)}`}
      footer={
        <HStack gap={3} vAlign="center">
          <QtyStepper product={product} value={q} onChange={(v) => setQ(v || product.min_qty)} />
          <StackItem size="fill">
            <Button label={inCart ? `Обновить · ${money(Math.round(product.price_cents * q), shop.tenant.currency)}` : `Добавить · ${money(Math.round(product.price_cents * q), shop.tenant.currency)}`}
              variant="primary" size="lg" width="100%" onClick={() => { cart.setQuantity(product, q); onClose() }} />
          </StackItem>
        </HStack>
      }>
      <VStack gap={3}>
        <span className="sheet-photo"><Photo path={product.image_path} alt={product.name} sizes="(max-width: 640px) 100vw, 640px" /></span>
        {product.badges.length || hint ? (
          <HStack gap={1} wrap="wrap">
            {product.badges.map((b) => <Badge key={b} label={b} />)}
            {hint ? <Badge label={hint} variant="warning" /> : null}
          </HStack>
        ) : null}
        {product.description ? <Text as="p">{product.description}</Text> : null}
        <Text type="supporting" as="p">
          Порция от {qty(product.min_qty, product.unit)} до {qty(product.max_qty, product.unit)}, шаг {qty(product.qty_step, product.unit)}.
          {product.unit === 'kg' ? ' Точный вес и сумму уточним при выдаче.' : ''}
          {prep ? ` Подготовка: ${prep.name.toLowerCase()}.` : ''}
        </Text>
        {inCart ? <Button label="Убрать из корзины" variant="ghost" onClick={() => { cart.setQuantity(product, 0); onClose() }} /> : null}
      </VStack>
    </Sheet>
  )
}
