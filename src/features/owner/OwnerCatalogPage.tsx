import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@astryxdesign/core/Button'
import { FileInput } from '@astryxdesign/core/FileInput'
import { Item } from '@astryxdesign/core/Item'
import { List } from '@astryxdesign/core/List'
import { Switch } from '@astryxdesign/core/Switch'
import { Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import { useToast } from '@astryxdesign/core/Toast'
import type { Product } from '@/api/types'
import { shopQueryKey, useShop, useSlug } from '@/app/shop-context'
import { PageHeader } from '@/components/PageHeader'
import { Photo } from '@/components/Photo'
import { QueryState } from '@/components/QueryState'
import { Sheet, useSheet } from '@/components/Sheet'
import { errorMessage } from '@/lib/errors'
import { money, unitLabel } from '@/lib/format'
import { NativeField, parseMoney } from './fields'
import { useOwner } from './owner-context'

/** Owner edits: price (orders keep their snapshot price), availability, photo. */
export function OwnerCatalogPage() {
  const { db, tenant, api, key } = useOwner()
  const shop = useShop()
  const slug = useSlug()
  const qc = useQueryClient()
  const showToast = useToast()
  const sheet = useSheet('edit')
  const q = useQuery({
    queryKey: key('products'),
    queryFn: async () => {
      const { data, error } = await db.from('products').select('*').eq('tenant_id', tenant.id).order('sort_order')
      if (error) throw error
      return data as Product[]
    },
  })
  const refresh = () => { qc.invalidateQueries({ queryKey: key('products') }); qc.invalidateQueries({ queryKey: shopQueryKey(slug) }) }
  const toggle = useMutation({ mutationFn: (p: Product) => api.updateProduct(p.id, { is_active: !p.is_active }), onSuccess: refresh })
  const editing = q.data?.find((p) => p.id === sheet.value) ?? null
  return (
    <VStack>
      <PageHeader title="Каталог" back={`/s/${slug}/owner/more`} />
      <QueryState query={q} isEmpty={(d) => d.length === 0} empty={{ title: 'Товаров нет', description: 'Товары добавляются через business.json и tenant:publish.' }}>
        {(list) => (
          <List hasDividers density="compact" aria-label="Товары">
            {list.map((p) => (
              <Item key={p.id} as="li" label={p.name} onClick={() => sheet.open(p.id)}
                description={`${money(p.price_cents, shop.tenant.currency)} / ${unitLabel(p.unit)}${p.image_source === 'owner' ? ' · своё фото' : ''}`}
                startContent={<span className="owner-thumb"><Photo path={p.image_path} alt="" sizes="56px" /></span>}
                endContent={<Switch label={`В продаже: ${p.name}`} isLabelHidden value={p.is_active} isLoading={toggle.isPending && toggle.variables?.id === p.id} onChange={() => toggle.mutate(p)} />} />
            ))}
          </List>
        )}
      </QueryState>
      {editing ? <EditSheet product={editing} isOpen={sheet.isOpen} onClose={sheet.close} onSaved={() => { refresh(); showToast({ body: 'Сохранено' }) }} /> : null}
    </VStack>
  )
}

function EditSheet({ product, isOpen, onClose, onSaved }: { product: Product; isOpen: boolean; onClose: () => void; onSaved: () => void }) {
  const { db, tenant, api } = useOwner()
  const shop = useShop()
  const [price, setPrice] = useState(String(product.price_cents / 100))
  const [file, setFile] = useState<File | null>(null)
  const save = useMutation({
    mutationFn: async () => {
      const cents = parseMoney(price)
      if (cents === null) throw new Error('invalid_amount')
      let imagePath: string | undefined
      if (file) {
        const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg'
        imagePath = `${tenant.id}/owner/${product.key}-${Date.now()}.${ext}`
        const up = await db.storage.from('tenant-media').upload(imagePath, file, { contentType: file.type, upsert: false })
        if (up.error) throw up.error
      }
      await api.updateProduct(product.id, { price_cents: cents, image_path: imagePath })
    },
    onSuccess: () => { onSaved(); onClose() },
  })
  return (
    <Sheet isOpen={isOpen} onClose={onClose} title={product.name} description="Новая цена применяется к новым заказам; оформленные заказы сохраняют свою цену."
      footer={<Button label="Сохранить" variant="primary" size="lg" width="100%" isLoading={save.isPending} onClick={() => save.mutate()} />}>
      <VStack gap={3}>
        <NativeField label={`Цена за ${unitLabel(product.unit)}, ${shop.tenant.currency}`} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
        <FileInput label="Фото товара" value={file} onChange={(f) => setFile(Array.isArray(f) ? f[0] ?? null : f)} accept="image/jpeg,image/png,image/webp" maxSize={5 * 1024 * 1024}
          description="JPG, PNG или WebP до 5 МБ. Ваше фото не перезапишется при обновлении каталога." />
        {save.isError ? <Text color="accent" role="alert">{errorMessage(save.error)}</Text> : null}
      </VStack>
    </Sheet>
  )
}
