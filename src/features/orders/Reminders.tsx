import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, CalendarPlus } from 'lucide-react'
import { useState } from 'react'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { Icon } from '@astryxdesign/core/Icon'
import { Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import { publicApi } from '@/api/public'
import { pushState, subscribePush } from '@/lib/push'

/** Two reminder channels with an honest state for each. */
export function Reminders({ slug, orderId, token }: { slug: string; orderId: string; token: string }) {
  const qc = useQueryClient()
  const state = useQuery({ queryKey: ['push-state', slug, 'client'], queryFn: () => pushState(slug, 'client') })
  const [error, setError] = useState<string | null>(null)
  const enable = async () => {
    setError(null)
    try {
      const sub = await subscribePush(slug, 'client')
      await publicApi.push(orderId, token, sub)
      await qc.invalidateQueries({ queryKey: ['push-state', slug, 'client'] })
    } catch (e) {
      setError((e as Error).message === 'permission_denied' ? 'Вы не разрешили уведомления.' : 'Не удалось включить уведомления.')
      await qc.invalidateQueries({ queryKey: ['push-state', slug, 'client'] })
    }
  }
  const s = state.data
  return (
    <VStack gap={2}>
      <Button label="Добавить в календарь" icon={<Icon icon={CalendarPlus} />} href={publicApi.icsUrl(orderId, token)} width="100%" />
      <Text type="supporting">Календарь сам напомнит за 2 часа. Работает на любом телефоне.</Text>
      {state.isPending ? null : s?.kind === 'available' ? (
        <Button label="Напомнить уведомлением" icon={<Icon icon={Bell} />} width="100%" clickAction={enable} />
      ) : s?.kind === 'subscribed' ? (
        <Text type="supporting" role="status">🔔 Уведомления включены: напомним за 2 часа и сообщим, когда заказ соберут.</Text>
      ) : s?.kind === 'ios-install' ? (
        <Banner status="info" title="Уведомления на iPhone" description="Safari присылает уведомления только установленным приложениям: «Поделиться» → «На экран Домой», затем откройте магазин с иконки." />
      ) : s?.kind === 'denied' ? (
        <Text type="supporting">Уведомления запрещены в настройках браузера — используйте календарь.</Text>
      ) : s?.kind === 'no-config' ? null : (
        <Text type="supporting">{s?.kind === 'unsupported' ? s.reason : ''}</Text>
      )}
      {error ? <Text color="accent" role="alert">{error}</Text> : null}
    </VStack>
  )
}
