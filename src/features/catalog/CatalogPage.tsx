import { useMemo, useState } from 'react'
import { ArrowRight, Clock, MapPin } from 'lucide-react'
import { Badge } from '@astryxdesign/core/Badge'
import { Button } from '@astryxdesign/core/Button'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { Heading } from '@astryxdesign/core/Heading'
import { HStack } from '@astryxdesign/core/HStack'
import { Icon } from '@astryxdesign/core/Icon'
import { StackItem } from '@astryxdesign/core/Stack'
import { Tab, TabList } from '@astryxdesign/core/TabList'
import { Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import { useShop, useSlug } from '@/app/shop-context'
import { Photo } from '@/components/Photo'
import { QtyStepper } from '@/components/QtyStepper'
import { useCart } from '@/lib/cart'
import { money, unitLabel } from '@/lib/format'
import { ProductSheet, prepHint } from './ProductSheet'
import { useSheet } from '@/components/Sheet'
import { todayHours } from './hours'
import type { Product } from '@/api/types'

export function CatalogPage() {
  const shop = useShop()
  const slug = useSlug()
  const cart = useCart(slug)
  const sheet = useSheet('product')
  const [category, setCategory] = useState('all')
  const { tenant } = shop
  const products = useMemo(() => shop.products.filter((p) => category === 'all' || p.category_id === category), [shop.products, category])
  const total = cart.lines.reduce((s, l) => s + Math.round((shop.products.find((p) => p.id === l.product_id)?.price_cents ?? 0) * l.quantity), 0)
  const hours = todayHours(shop)
  const selected = shop.products.find((p) => p.key === sheet.value) ?? null

  return (
    <VStack gap={0}>
      <section className="hero" aria-label={tenant.name}>
        <Photo path={tenant.profile.hero_image} alt="" ratio={16 / 10} widths={[800, 1600]} sizes="100vw" priority />
        <div className="hero-overlay">
          <VStack gap={1} padding={4}>
            <Heading level={1} type="display-3">{tenant.name}</Heading>
            {tenant.profile.tagline ? <Text color="secondary">{tenant.profile.tagline}</Text> : null}
          </VStack>
        </div>
      </section>

      <VStack gap={2} paddingInline={4} paddingBlock={3}>
        <HStack gap={2} vAlign="center">
          <Icon icon={MapPin} size="sm" color="secondary" />
          <Text type="supporting" maxLines={1}>Самовывоз: {tenant.profile.contacts?.address}</Text>
        </HStack>
        <HStack gap={2} vAlign="center">
          <Icon icon={Clock} size="sm" color="secondary" />
          <Text type="supporting">{hours}</Text>
        </HStack>
      </VStack>

      <nav className="category-strip" aria-label="Категории">
        <TabList value={category} onChange={setCategory} layout="hug" hasDivider>
          <Tab value="all" label="Всё" />
          {shop.categories.map((c) => <Tab key={c.id} value={c.id} label={c.name} />)}
        </TabList>
      </nav>

      {products.length === 0 ? (
        <EmptyState title="Пока пусто" description="В этой категории сейчас нет товаров." />
      ) : (
        <ul className="product-list" aria-label="Товары">
          {products.map((p) => (
            <ProductRow key={p.id} product={p} currency={tenant.currency} quantity={cart.quantityOf(p.id)}
              onOpen={() => sheet.open(p.key)} onQuantity={(q) => cart.setQuantity(p, q)} hint={prepHint(shop, p)} />
          ))}
        </ul>
      )}

      {cart.count > 0 ? (
        <div className="cart-bar">
          <Button label={`Корзина · ${cart.count} · ${money(total, tenant.currency)}`} variant="primary" size="lg" width="100%"
            href={`/s/${slug}/cart`} endContent={<Icon icon={ArrowRight} />} />
        </div>
      ) : null}

      <ProductSheet product={selected} isOpen={sheet.isOpen && !!selected} onClose={sheet.close} />
    </VStack>
  )
}

function ProductRow({ product: p, currency, quantity, onOpen, onQuantity, hint }:
  { product: Product; currency: string; quantity: number; onOpen: () => void; onQuantity: (q: number) => void; hint: string | null }) {
  return (
    <li className="product-row">
      <button type="button" className="product-hit" onClick={onOpen} aria-label={`${p.name}, подробнее`}>
        <span className="product-thumb"><Photo path={p.image_path} alt="" sizes="112px" /></span>
      </button>
      <VStack gap={1}>
        <button type="button" className="product-title" onClick={onOpen}>
          <Text type="label" weight="semibold" maxLines={2}>{p.name}</Text>
        </button>
        <HStack gap={1} wrap="wrap">
          {p.badges.map((b) => <Badge key={b} label={b} variant="neutral" />)}
          {hint ? <Badge label={hint} variant="warning" /> : null}
        </HStack>
        <HStack gap={2} vAlign="center">
          <StackItem size="fill">
            <Text weight="semibold" hasTabularNumbers>{money(p.price_cents, currency)}<Text type="supporting"> / {unitLabel(p.unit)}</Text></Text>
          </StackItem>
          {quantity > 0
            ? <QtyStepper product={p} value={quantity} onChange={onQuantity} size="sm" />
            : <Button label="В корзину" size="sm" variant="secondary" onClick={() => onQuantity(p.min_qty)} />}
        </HStack>
      </VStack>
    </li>
  )
}
