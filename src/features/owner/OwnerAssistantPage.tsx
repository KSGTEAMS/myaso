import { VStack } from '@astryxdesign/core/VStack'
import { useSlug } from '@/app/shop-context'
import { PageHeader } from '@/components/PageHeader'
import { AssistantChat } from '@/features/assistant/AssistantChat'
import { useOwner } from './owner-context'

export function OwnerAssistantPage() {
  const slug = useSlug()
  const { db } = useOwner()
  return (
    <VStack>
      <PageHeader title="Помощник" back={`/s/${slug}/owner/more`} />
      <AssistantChat slug={slug} scope="owner" greeting="Спросите про заказы, выдачу, загрузку или деньги — я сначала проверю данные."
        suggestions={['Сколько оплат получили сегодня?', 'Какие заказы на завтра?', 'Статистика за неделю']}
        getJwt={async () => (await db.auth.getSession()).data.session?.access_token} />
    </VStack>
  )
}
