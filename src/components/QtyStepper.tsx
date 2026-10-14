import { Minus, Plus } from 'lucide-react'
import { HStack } from '@astryxdesign/core/HStack'
import { Icon } from '@astryxdesign/core/Icon'
import { IconButton } from '@astryxdesign/core/IconButton'
import { Text } from '@astryxdesign/core/Text'
import { qty as fmtQty } from '@/lib/format'
import type { Product } from '@/api/types'

export function QtyStepper({ product, value, onChange, size = 'md' }: { product: Product; value: number; onChange: (q: number) => void; size?: 'sm' | 'md' }) {
  const dec = () => onChange(value - product.qty_step < product.min_qty ? 0 : Number((value - product.qty_step).toFixed(3)))
  const inc = () => onChange(value === 0 ? product.min_qty : Math.min(product.max_qty, Number((value + product.qty_step).toFixed(3))))
  return (
    <HStack gap={2} vAlign="center" role="group" aria-label={`Количество: ${product.name}`}>
      <IconButton label={value <= product.min_qty ? 'Убрать из корзины' : 'Меньше'} icon={<Icon icon={Minus} />} size={size} onClick={dec} isDisabled={value === 0} />
      <Text type="label" hasTabularNumbers aria-live="polite">{fmtQty(value, product.unit)}</Text>
      <IconButton label="Больше" icon={<Icon icon={Plus} />} size={size} variant="primary" onClick={inc} isDisabled={value >= product.max_qty} />
    </HStack>
  )
}
