import { useState } from 'react'
import { VStack } from '@astryxdesign/core/VStack'
import { useShop, useSlug } from '@/app/shop-context'
import { PageHeader } from '@/components/PageHeader'
import { myOrdersStore } from '@/lib/my-orders'
import { AssistantChat } from './AssistantChat'

export function ClientAssistantPage() {
  const shop = useShop()
  const slug = useSlug()
  const [since] = useState(() => Date.now() - 86400_000)
  const latest = myOrdersStore(slug).use().find((o) => new Date(o.pickup_at).getTime() > since)
  return (
    <VStack>
      <PageHeader title="Помощник" />
      <AssistantChat slug={slug} scope="client"
        greeting={shop.tenant.profile.ai?.greeting ?? 'Подскажу по товарам и времени выдачи.'}
        suggestions={['Что взять на гриль?', 'Когда можно забрать заказ?', 'Где вы находитесь?', ...(latest ? ['Какой статус моего заказа?'] : [])]}
        order={latest ? { id: latest.id, token: latest.token } : undefined} />
    </VStack>
  )
}
