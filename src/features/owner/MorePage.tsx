import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, Bot, LogOut, Package, Smartphone } from 'lucide-react'
import { useState } from 'react'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { Heading } from '@astryxdesign/core/Heading'
import { Icon } from '@astryxdesign/core/Icon'
import { Item } from '@astryxdesign/core/Item'
import { List } from '@astryxdesign/core/List'
import { Switch } from '@astryxdesign/core/Switch'
import { Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import { useSlug } from '@/app/shop-context'
import { PageHeader } from '@/components/PageHeader'
import { isIos, isStandalone, pushState, subscribePush, unsubscribePush } from '@/lib/push'
import { useOwner } from './owner-context'

export function MorePage() {
  const slug = useSlug()
  const { session, logout, api, key } = useOwner()
  const qc = useQueryClient()
  const push = useQuery({ queryKey: key('push'), queryFn: () => pushState(slug, 'owner') })
  const [pushError, setPushError] = useState<string | null>(null)
  const togglePush = async (on: boolean) => {
    setPushError(null)
    try {
      if (on) await api.registerPush(await subscribePush(slug, 'owner'))
      else { const ep = await unsubscribePush(slug, 'owner'); if (ep) await api.unregisterPush(ep) }
    } catch (e) {
      setPushError((e as Error).message === 'permission_denied' ? 'Уведомления не разрешены.' : 'Не удалось изменить настройку.')
    }
    await qc.invalidateQueries({ queryKey: key('push') })
  }
  const s = push.data
  const base = `/s/${slug}/owner`
  return (
    <VStack>
      <PageHeader title="Ещё" />
      <VStack gap={5} paddingInline={4} paddingBlockEnd={6}>
        <List hasDividers>
          <Item as="li" href={`${base}/catalog`} label="Каталог и цены" description="Наличие, цены, фото" startContent={<Icon icon={Package} />} />
          <Item as="li" href={`${base}/assistant`} label="Помощник" description="Вопросы о заказах и деньгах" startContent={<Icon icon={Bot} />} />
        </List>
        <VStack gap={2}>
          <Heading level={3}>Уведомления о заказах</Heading>
          {s?.kind === 'available' || s?.kind === 'subscribed' ? (
            <Switch label="Новые заказы, переносы и отмены" value={s.kind === 'subscribed'} changeAction={togglePush} labelIcon={Bell} labelSpacing="spread" width="100%" />
          ) : s?.kind === 'ios-install' ? (
            <Banner status="info" title="Установите кабинет на экран Домой" description="На iPhone push приходят только установленному приложению: Safari → «Поделиться» → «На экран Домой»." />
          ) : s?.kind === 'denied' ? (
            <Text type="supporting">Уведомления запрещены в настройках браузера для этого сайта.</Text>
          ) : s?.kind === 'no-config' ? (
            <Text type="supporting">Push не настроен на сервере (нет VAPID-ключа).</Text>
          ) : s?.kind === 'unsupported' ? <Text type="supporting">{s.reason}</Text> : null}
          {pushError ? <Text color="accent" role="alert">{pushError}</Text> : null}
        </VStack>
        {!isStandalone() ? (
          <VStack gap={1}>
            <Heading level={3}><Icon icon={Smartphone} size="sm" /> Приложение кабинета</Heading>
            <Text type="supporting">{isIos() ? 'Safari → «Поделиться» → «На экран Домой».' : 'Меню браузера → «Установить приложение».'} Кабинет ставится отдельно от витрины.</Text>
          </VStack>
        ) : null}
        <VStack gap={2}>
          <Text type="supporting">Вы вошли как {session.user.email}</Text>
          <Button label="Выйти" icon={<Icon icon={LogOut} />} variant="destructive" clickAction={logout} />
          <Text type="supporting" size="2xs">При выходе с устройства удаляются сессия, данные кабинета и подписка на уведомления.</Text>
        </VStack>
      </VStack>
    </VStack>
  )
}
