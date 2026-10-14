import { useEffect, useRef, useState } from 'react'
import { SendHorizontal } from 'lucide-react'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { HStack } from '@astryxdesign/core/HStack'
import { Icon } from '@astryxdesign/core/Icon'
import { IconButton } from '@astryxdesign/core/IconButton'
import { StackItem } from '@astryxdesign/core/Stack'
import { Text } from '@astryxdesign/core/Text'
import { TextArea } from '@astryxdesign/core/TextArea'
import { VStack } from '@astryxdesign/core/VStack'
import { askAssistant, type AssistantReply } from '@/api/assistant'
import { errorMessage } from '@/lib/errors'

type Msg = { role: 'user' | 'assistant'; content: string; meta?: AssistantReply }

/**
 * Chat with the shop assistant. History lives in memory only (never in
 * storage or the service worker). Ordering never depends on it: when the AI
 * is unavailable the server answers from data or points to the catalog.
 */
export function AssistantChat({ slug, scope, greeting, suggestions, getJwt, order }: {
  slug: string; scope: 'client' | 'owner'; greeting: string; suggestions: string[]
  getJwt?: () => Promise<string | undefined>; order?: { id: string; token: string }
}) {
  const [messages, setMessages] = useState<Msg[]>([])
  const [text, setText] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'end' }) }, [messages, pending])

  const send = async (content: string) => {
    const trimmed = content.trim()
    if (!trimmed || pending) return
    const next: Msg[] = [...messages, { role: 'user', content: trimmed }]
    setMessages(next)
    setText('')
    setPending(true)
    setError(null)
    try {
      const reply = await askAssistant({ slug, scope, order, jwt: await getJwt?.(),
        messages: next.slice(-12).map(({ role, content: c }) => ({ role, content: c })) })
      setMessages((m) => [...m, { role: 'assistant', content: reply.answer, meta: reply }])
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setPending(false)
    }
  }

  return (
    <VStack gap={3} paddingInline={4} paddingBlockEnd={4}>
      <ol className="chat-log" aria-live="polite" aria-label="Диалог с помощником">
        <li className="chat-msg chat-msg-assistant"><Text>{greeting}</Text></li>
        {messages.map((m, i) => (
          <li key={i} className={`chat-msg chat-msg-${m.role}`}>
            <Text as="p" textWrap="pretty">{m.content}</Text>
            {m.meta?.mode === 'fallback' ? <Text type="supporting" size="2xs">Ответ по данным магазина, без ИИ</Text> : null}
            {m.meta?.tools.length ? <Text type="supporting" size="2xs">Проверено: {m.meta.tools.filter((t) => t.ok).map((t) => TOOL_LABEL[t.name] ?? t.name).join(', ')}</Text> : null}
          </li>
        ))}
        {pending ? <li className="chat-msg chat-msg-assistant"><Text type="supporting">Смотрю данные…</Text></li> : null}
      </ol>
      <div ref={endRef} />
      {error ? <Banner status="error" title={error} endContent={<Button label="Повторить" size="sm" onClick={() => { const last = messages.at(-1); if (last?.role === 'user') { setMessages(messages.slice(0, -1)); void send(last.content) } }} />} /> : null}
      {messages.length === 0 ? (
        <HStack gap={2} wrap="wrap">{suggestions.map((s) => <Button key={s} label={s} size="sm" onClick={() => send(s)} />)}</HStack>
      ) : null}
      <form className="chat-form" onSubmit={(e) => { e.preventDefault(); void send(text) }}>
        <HStack gap={2} vAlign="end">
          <StackItem size="fill">
            <TextArea label="Сообщение" isLabelHidden value={text} onChange={setText} rows={1} placeholder="Спросите о товарах, времени, заказе"
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(text) } }} />
          </StackItem>
          <IconButton label="Отправить" variant="primary" icon={<Icon icon={SendHorizontal} />} isLoading={pending} isDisabled={!text.trim()} onClick={() => send(text)} />
        </HStack>
      </form>
    </VStack>
  )
}

const TOOL_LABEL: Record<string, string> = {
  catalog: 'каталог', pickup_slots: 'время выдачи', shop_info: 'контакты', my_order: 'ваш заказ',
  schedule: 'расписание', stats: 'статистика', find_orders: 'поиск заказов',
}
