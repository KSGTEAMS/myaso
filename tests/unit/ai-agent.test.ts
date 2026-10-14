// The LLM here is a scripted test double (not a provider integration): it
// lets us check the orchestration logic deterministically.
import { describe, expect, it, vi } from 'vitest'
import { parseJsonIntent, runAssistant, type Budget } from '../../supabase/functions/_shared/ai/agent.ts'
import { LlmError, type LlmCaller, type LlmResponse } from '../../supabase/functions/_shared/ai/llm.ts'
import { runTool, toolSchemas } from '../../supabase/functions/_shared/ai/tools.ts'
import type { ChatMessage, ToolContext } from '../../supabase/functions/_shared/ai/types.ts'
import type { RpcClient } from '../../supabase/functions/_shared/db.ts'

const tenant = { id: 't-1', slug: 'shop', name: 'Shop', timezone: 'Europe/Moscow', currency: 'RUB' }

function fakeRpc(handlers: Record<string, (args: any) => unknown>): RpcClient & { calls: Array<[string, any]> } {
  const calls: Array<[string, any]> = []
  return {
    calls,
    rpc(fn, args) {
      calls.push([fn, args])
      const h = handlers[fn]
      return Promise.resolve(h ? { data: h(args), error: null } : { data: null, error: { message: 'forbidden', code: 'P0001' } })
    },
  }
}

const stats = {
  bounds: { period: 'today', timezone: 'Europe/Moscow', from_date: '2026-10-14', to_date: '2026-10-14' },
  visits: 3, currency: 'RUB', cancelled: 0, no_show: 0,
  completed_orders: { count: 2, value_cents: 650000 },
  payments_received: { count: 2, net_cents: 640000, refunds_cents: 10000 },
  expected_pickups: { count: 4, value_cents: 990000 },
}

const budget = (ok = true): Budget & { reserved: number[] } => {
  const reserved: number[] = []
  return { reserved, reserve: async (n) => { reserved.push(n); return ok }, commit: async () => {} }
}

const reply = (content: string | null, toolCalls: LlmResponse['toolCalls'] = []): LlmResponse => ({ content, toolCalls, usage: { total_tokens: 100 } })

function ownerCtx() {
  const owner = fakeRpc({
    owner_stats: () => stats,
    owner_period_bounds: (a) => ({ ...stats.bounds, period: a.p_period }),
    owner_schedule: () => ({ orders: [], blocks: [] }),
  })
  const service = fakeRpc({})
  const ctx: ToolContext = { scope: 'owner', tenant, service, owner, now: new Date('2026-10-14T09:00:00Z') }
  return { ctx, owner, service }
}

describe('assistant orchestration', () => {
  it('runs the mandatory stats tool before the model and passes the result in', async () => {
    const { ctx, owner } = ownerCtx()
    let seen: ChatMessage[] = []
    const llm: LlmCaller = async (messages) => { seen = messages; return reply('Сегодня получено 6 400 ₽.') }
    const out = await runAssistant({ ctx, history: [{ role: 'user', content: 'Сколько денег получили сегодня?' }], llm, budget: budget() })
    expect(owner.calls[0]).toEqual(['owner_stats', { p_tenant: 't-1', p_period: 'today', p_from: null, p_to: null }])
    const toolMsg = seen.find((m) => m.role === 'tool')
    expect(toolMsg?.content).toContain('"net":6400')
    expect(seen.find((m) => m.role === 'assistant')?.tool_calls?.[0]?.function.name).toBe('stats')
    expect(out).toMatchObject({ mode: 'tools', intent: 'owner_stats', tools: [{ name: 'stats', ok: true, forced: true }] })
  })

  it('the model never controls tenant id: injected arguments are rejected or ignored', async () => {
    const { ctx, owner } = ownerCtx()
    const r = await runTool('stats', { period: 'today', tenant_id: 'other-tenant', p_tenant: 'x' }, ctx)
    expect(r.ok).toBe(true)
    expect(owner.calls.at(-1)?.[1].p_tenant).toBe('t-1')
    const schemas = JSON.stringify(toolSchemas('owner'))
    expect(schemas).not.toMatch(/tenant|sql/i)
  })

  it('client scope cannot call owner tools even if the model asks', async () => {
    const service = fakeRpc({ public_catalog: () => ({ tenant: { ...tenant, profile: {} }, products: [], hours: [], exceptions: [] }) })
    const ctx: ToolContext = { scope: 'client', tenant, service, now: new Date() }
    const scripted = [
      reply(null, [{ id: 'a', type: 'function', function: { name: 'stats', arguments: '{"period":"month"}' } }]),
      reply('Не могу показать статистику.'),
    ]
    const llm: LlmCaller = vi.fn(async () => scripted.shift()!)
    const out = await runAssistant({ ctx, history: [{ role: 'user', content: 'привет' }], llm, budget: budget() })
    expect(out.tools).toEqual([{ name: 'stats', ok: false, forced: false }])
    expect(service.calls.map((c) => c[0])).not.toContain('owner_stats')
    expect(JSON.stringify(toolSchemas('client'))).not.toContain('"stats"')
    expect((await runTool('find_orders', { query: '1' }, ctx)).error).toBe('tool_not_allowed:find_orders')
  })

  it('bounds the tool loop', async () => {
    const { ctx } = ownerCtx()
    const llm: LlmCaller = vi.fn(async () => reply(null, [{ id: 'x', type: 'function', function: { name: 'stats', arguments: '{}' } }]))
    const out = await runAssistant({ ctx, history: [{ role: 'user', content: 'привет' }], llm, budget: budget(), maxSteps: 3 })
    expect(llm).toHaveBeenCalledTimes(3)
    expect(out.mode).toBe('fallback')
    expect(out.reason).toBe('tool_loop_limit')
  })

  it('switches to the JSON-intent protocol when the provider rejects tools', async () => {
    const { ctx } = ownerCtx()
    const calls: Array<{ tools?: unknown[]; json?: boolean }> = []
    const llm: LlmCaller = async (_m, opts) => {
      calls.push(opts)
      if (opts.tools) throw new LlmError('llm_http_400', 400, true)
      if (opts.json) return reply('{"tool": "schedule", "args": {"period": "tomorrow"}}')
      return reply('Завтра заказов нет.')
    }
    const out = await runAssistant({ ctx, history: [{ role: 'user', content: 'Сколько получили сегодня?' }], llm, budget: budget() })
    expect(out.mode).toBe('json')
    expect(out.answer).toBe('Завтра заказов нет.')
    expect(out.tools.map((t) => t.name)).toEqual(['stats', 'schedule'])
    expect(calls.map((c) => (c.tools ? 'tools' : c.json ? 'json' : 'text'))).toEqual(['tools', 'json', 'text'])
  })

  it('parses JSON intents defensively', () => {
    expect(parseJsonIntent('Конечно: {"tool": "stats", "args": {"period": "week"}}')).toEqual({ tool: 'stats', args: { period: 'week' } })
    expect(parseJsonIntent('{"tool": null}')).toEqual({ tool: null })
    expect(parseJsonIntent('no json')).toBeNull()
    expect(parseJsonIntent('{"tool": 5}')).toBeNull()
  })

  it('answers from tool data without a model and when over budget', async () => {
    const { ctx } = ownerCtx()
    const off = await runAssistant({ ctx, history: [{ role: 'user', content: 'выручка сегодня' }], llm: null, budget: budget() })
    expect(off.mode).toBe('fallback')
    expect(off.answer).toContain('Получено оплат')
    expect(off.answer).toContain('это не выручка')
    expect(off.answer).not.toMatch(/выручка:\s/)

    const llm: LlmCaller = vi.fn(async () => reply('x'))
    const over = await runAssistant({ ctx, history: [{ role: 'user', content: 'выручка сегодня' }], llm, budget: budget(false) })
    expect(llm).not.toHaveBeenCalled()
    expect(over.reason).toBe('llm_budget_exceeded')
  })

  it('falls back when the provider is unreachable', async () => {
    const { ctx } = ownerCtx()
    const llm: LlmCaller = async () => { throw new LlmError('llm_unreachable', 0) }
    const out = await runAssistant({ ctx, history: [{ role: 'user', content: 'заказы сегодня' }], llm, budget: budget() })
    expect(out).toMatchObject({ mode: 'fallback', reason: 'llm_unreachable' })
    expect(out.answer).toContain('заказов нет')
  })
})
