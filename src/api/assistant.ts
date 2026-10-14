import { env } from '@/lib/env'
import { ApiError } from '@/lib/errors'
import { functionsUrl } from '@/lib/supabase'

export interface AssistantReply {
  answer: string
  mode: 'tools' | 'json' | 'fallback'
  intent: string
  tools: Array<{ name: string; ok: boolean; forced: boolean }>
  reason?: string
}

export async function askAssistant(input: {
  slug: string
  scope: 'client' | 'owner'
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  jwt?: string
  order?: { id: string; token: string }
}): Promise<AssistantReply> {
  let res: Response
  try {
    res = await fetch(functionsUrl('ai-chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: env.anonKey, Authorization: `Bearer ${input.jwt ?? env.anonKey}` },
      body: JSON.stringify({ slug: input.slug, scope: input.scope, messages: input.messages, order: input.order }),
    })
  } catch {
    throw new ApiError('network')
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(data.error ?? 'internal_error', res.status)
  return data as AssistantReply
}
