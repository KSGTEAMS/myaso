// OpenAI-compatible chat completions client. Provider, key and model are
// configured with LLM_BASE_URL / LLM_API_KEY / LLM_MODEL (server secrets).
import type { ChatMessage, ToolCall } from './types.ts'

export interface LlmConfig {
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs?: number
  maxTokens?: number
  /** Send response_format=json_object in JSON-intent mode (some providers reject it). */
  jsonResponseFormat?: boolean
}

export interface LlmResponse {
  content: string | null
  toolCalls: ToolCall[]
  usage: { total_tokens: number }
}

export class LlmError extends Error {
  constructor(message: string, public status: number, public toolsUnsupported = false) { super(message) }
}

export type LlmCaller = (messages: ChatMessage[], opts: { tools?: unknown[]; json?: boolean }) => Promise<LlmResponse>

export function createLlm(cfg: LlmConfig, fetchImpl: typeof fetch = fetch): LlmCaller {
  return async (messages, opts) => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 20_000)
    try {
      const res = await fetchImpl(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model,
          messages,
          temperature: 0.2,
          max_tokens: cfg.maxTokens ?? 600,
          ...(opts.tools?.length ? { tools: opts.tools, tool_choice: 'auto' } : {}),
          ...(opts.json && cfg.jsonResponseFormat !== false ? { response_format: { type: 'json_object' } } : {}),
        }),
      })
      const text = await res.text()
      if (!res.ok) {
        throw new LlmError(`llm_http_${res.status}`, res.status,
          res.status === 400 && /tool|function/i.test(text))
      }
      const body = JSON.parse(text)
      const msg = body.choices?.[0]?.message ?? {}
      return {
        content: typeof msg.content === 'string' ? msg.content : null,
        toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
        usage: { total_tokens: Number(body.usage?.total_tokens ?? 0) },
      }
    } catch (e) {
      if (e instanceof LlmError) throw e
      throw new LlmError((e as Error).name === 'AbortError' ? 'llm_timeout' : 'llm_unreachable', 0)
    } finally {
      clearTimeout(timer)
    }
  }
}
