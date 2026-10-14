// Assistant orchestration:
//   1. the deterministic router picks mandatory tools and the server runs them;
//   2. their results are handed to the model as tool messages;
//   3. a bounded tool loop lets the model call more (scope-checked) tools;
//   4. providers without function calling get a JSON-intent protocol;
//   5. without a model (no key, outage, budget) a deterministic answer is built.
import { z } from 'zod'
import { fallbackAnswer } from './fallback.ts'
import { LlmError, type LlmCaller } from './llm.ts'
import { routeMessage, type Intent } from './router.ts'
import { runTool, toolSchemas, toolsForScope } from './tools.ts'
import type { ChatMessage, ToolContext, ToolResult } from './types.ts'

export interface Budget {
  reserve(tokens: number): Promise<boolean>
  commit(reserved: number, actual: number): Promise<void>
}

export interface AssistantInput {
  ctx: ToolContext
  history: Array<{ role: 'user' | 'assistant'; content: string }>
  llm: LlmCaller | null
  mode?: 'auto' | 'tools' | 'json'
  budget: Budget
  maxSteps?: number
}

export interface AssistantOutput {
  answer: string
  mode: 'tools' | 'json' | 'fallback'
  intent: Intent
  tools: Array<{ name: string; ok: boolean; forced: boolean }>
  reason?: string
}

const MAX_RESULT_CHARS = 6000
const clip = (v: unknown) => {
  const s = JSON.stringify(v)
  return s.length > MAX_RESULT_CHARS ? `${s.slice(0, MAX_RESULT_CHARS)}…` : s
}

function systemPrompt(ctx: ToolContext): string {
  const local = new Intl.DateTimeFormat('ru-RU', { timeZone: ctx.tenant.timezone, dateStyle: 'full', timeStyle: 'short' }).format(ctx.now)
  const role = ctx.scope === 'owner'
    ? 'Ты помощник владельца мясного магазина в его кабинете. Отвечай о заказах, выдачах, загрузке и деньгах только по данным инструментов. Различай: визиты за заказами, выданные заказы, полученные платежи и ожидаемые выдачи. Ожидаемые выдачи никогда не называй выручкой.'
    : 'Ты помощник покупателя мясного магазина (только самовывоз). Помогай выбрать товары и время выдачи. Ты не оформляешь, не переносишь и не отменяешь заказы — для этого есть кнопки в приложении.'
  return [
    role,
    `Магазин: ${ctx.tenant.name}. Часовой пояс магазина: ${ctx.tenant.timezone}. Сейчас там: ${local}. Валюта: ${ctx.tenant.currency}.`,
    'Никогда не придумывай цены, время, статусы и суммы: если данных нет — скажи об этом. Время называй по часовому поясу магазина.',
    'Отвечай по-русски, коротко и по делу, без markdown-таблиц.',
  ].join('\n')
}

let seq = 0
const callId = () => `call_${Date.now().toString(36)}_${(seq++).toString(36)}`

function estimate(messages: ChatMessage[]): number {
  return Math.ceil(messages.reduce((n, m) => n + (m.content?.length ?? 0) + JSON.stringify(m.tool_calls ?? '').length, 0) / 3) + 600
}

const JsonIntent = z.object({ tool: z.string().nullable(), args: z.record(z.string(), z.unknown()).optional() })

export function parseJsonIntent(text: string | null): z.infer<typeof JsonIntent> | null {
  if (!text) return null
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const r = JsonIntent.safeParse(JSON.parse(match[0]))
    return r.success ? r.data : null
  } catch {
    return null
  }
}

export async function runAssistant(input: AssistantInput): Promise<AssistantOutput> {
  const { ctx, llm, budget } = input
  const maxSteps = input.maxSteps ?? 4
  const history = input.history.slice(-12)
  const last = [...history].reverse().find((m) => m.role === 'user')?.content ?? ''
  const route = routeMessage(ctx.scope, last, { hasOrderAccess: !!ctx.orderAccess })
  const used: AssistantOutput['tools'] = []
  const results: Array<{ tool: string; args: Record<string, unknown>; result: ToolResult }> = []

  const exec = async (tool: string, args: Record<string, unknown>, forced: boolean) => {
    const result = await runTool(tool, args, ctx)
    used.push({ name: tool, ok: result.ok, forced })
    results.push({ tool, args, result })
    return result
  }

  // 1. Mandatory server-side tools.
  for (const c of route.calls) await exec(c.tool, c.args, true)
  if (route.intent === 'client_slots') {
    const cat = results.find((r) => r.tool === 'catalog' && r.result.ok)?.result.data as any
    const text = last.toLowerCase()
    const hit = cat?.products.find((p: any) => p.name.toLowerCase().split(/\s+/).some((w: string) => w.length > 3 && text.includes(w.slice(0, -1))))
    if (hit) await exec('pickup_slots', { items: [{ product_key: hit.key, quantity: Number(hit.min_qty) }] }, true)
  }

  const fallback = (reason: string): AssistantOutput => ({
    answer: fallbackAnswer(route.intent, [...results].reverse(), ctx.tenant.timezone),
    mode: 'fallback', intent: route.intent, tools: used, reason,
  })
  if (!llm) return fallback('llm_disabled')

  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt(ctx) }, ...history.map((m) => ({ ...m }))]
  if (results.length) {
    const calls = results.map((r) => ({ id: callId(), type: 'function' as const, function: { name: r.tool, arguments: JSON.stringify(r.args) } }))
    messages.push({ role: 'assistant', content: null, tool_calls: calls })
    results.forEach((r, i) => messages.push({ role: 'tool', tool_call_id: calls[i]!.id, content: clip(r.result) }))
  }

  const ask = async (msgs: ChatMessage[], opts: { tools?: unknown[]; json?: boolean }) => {
    const reserved = estimate(msgs)
    if (!(await budget.reserve(reserved))) throw new LlmError('llm_budget_exceeded', 429)
    try {
      const res = await llm(msgs, opts)
      await budget.commit(reserved, res.usage.total_tokens || reserved)
      return res
    } catch (e) {
      await budget.commit(reserved, 0)
      throw e
    }
  }

  const jsonMode = async (): Promise<AssistantOutput> => {
    const catalog = toolsForScope(ctx.scope).map((t) => `- ${t.name}: ${t.description} Аргументы (JSON Schema): ${JSON.stringify(z.toJSONSchema(t.args))}`).join('\n')
    const planMsgs: ChatMessage[] = [
      ...messages,
      { role: 'system', content: `Выбери, нужен ли ещё инструмент. Доступно:\n${catalog}\nВерни только JSON: {"tool": "<имя>" или null, "args": {...}}` },
    ]
    const plan = parseJsonIntent((await ask(planMsgs, { json: true })).content)
    const extra: ChatMessage[] = []
    if (plan?.tool) {
      const r = await exec(plan.tool, plan.args ?? {}, false)
      extra.push({ role: 'system', content: `Результат инструмента ${plan.tool}: ${clip(r)}` })
    }
    const final = await ask([...messages, ...extra, { role: 'system', content: 'Теперь ответь пользователю по этим данным.' }], {})
    if (!final.content?.trim()) return fallback('empty_answer')
    return { answer: final.content.trim(), mode: 'json', intent: route.intent, tools: used }
  }

  try {
    if (input.mode === 'json') return await jsonMode()
    const tools = toolSchemas(ctx.scope)
    for (let step = 0; step < maxSteps; step++) {
      const res = await ask(messages, { tools })
      if (!res.toolCalls.length) {
        if (!res.content?.trim()) return fallback('empty_answer')
        return { answer: res.content.trim(), mode: 'tools', intent: route.intent, tools: used }
      }
      messages.push({ role: 'assistant', content: res.content, tool_calls: res.toolCalls })
      for (const tc of res.toolCalls) {
        let args: unknown = {}
        try { args = JSON.parse(tc.function.arguments || '{}') } catch { /* invalid JSON -> zod rejects */ args = null }
        const r = await exec(tc.function.name, (args ?? {}) as Record<string, unknown>, false)
        messages.push({ role: 'tool', tool_call_id: tc.id, content: clip(r) })
      }
    }
    return fallback('tool_loop_limit')
  } catch (e) {
    if (e instanceof LlmError && e.toolsUnsupported && input.mode !== 'tools') {
      try { return await jsonMode() } catch (e2) { return fallback((e2 as Error).message) }
    }
    return fallback((e as Error).message)
  }
}
