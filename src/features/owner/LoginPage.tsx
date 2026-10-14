import { useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { Heading } from '@astryxdesign/core/Heading'
import { Text } from '@astryxdesign/core/Text'
import { TextInput } from '@astryxdesign/core/TextInput'
import { VStack } from '@astryxdesign/core/VStack'
import { useShop } from '@/app/shop-context'

export function LoginPage({ db }: { db: SupabaseClient }) {
  const shop = useShop()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    setBusy(true)
    setError(null)
    const { error: e } = await db.auth.signInWithPassword({ email: email.trim(), password })
    setBusy(false)
    if (e) setError(e.status === 400 ? 'Неверный e-mail или пароль.' : 'Не удалось войти. Проверьте соединение.')
  }
  return (
    <VStack minHeight="100dvh" vAlign="center" padding={6} gap={4} maxWidth={420} as="main">
      <VStack gap={1}>
        <Text type="supporting">{shop.tenant.name}</Text>
        <Heading level={1}>Кабинет магазина</Heading>
      </VStack>
      <form onSubmit={(e) => { e.preventDefault(); void submit() }} aria-label="Вход в кабинет">
        <VStack gap={3}>
          <TextInput label="E-mail" type="email" value={email} onChange={setEmail} autoComplete="username" isRequired hasAutoFocus />
          <TextInput label="Пароль" type="password" value={password} onChange={setPassword} autoComplete="current-password" isRequired onEnter={submit} />
          {error ? <Banner status="error" title={error} /> : null}
          <Button label="Войти" type="submit" variant="primary" size="lg" width="100%" isLoading={busy} />
        </VStack>
      </form>
      <Text type="supporting">Регистрации нет: доступ выдаёт администратор платформы.</Text>
    </VStack>
  )
}
