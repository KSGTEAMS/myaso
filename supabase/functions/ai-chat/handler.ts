// AI assistant endpoint for both the storefront and the owner cabinet.
// Ordering never depends on this function: if it fails, the UI keeps working.
import { z } from 'zod'
import { runAssistant } from '../_shared/ai/agent.ts'
import { createLlm, type LlmCaller } from '../_shared/ai/llm.ts'
import type { TenantContext, ToolContext } from '../_shared/ai/types.ts'
import { call, enforceRateLimits, type RpcClient } from '../_shared/db.ts'
import { HttpError, clientIp, corsHeaders, errorResponse, json, readJson, sha256Hex, type Env } from '../_shared/http.ts'

const Body = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/),
  scope: z.enum(['client', 'owner']),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(2000) })).min(1).max(20),
  order: z.object({ id: z.uuid(), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).optional(),
})

export interface AiDeps {
  env: Env
  service: RpcClient
  /** Builds a client that sends the caller's JWT, so SQL sees auth.uid(). */
  userClient: (jwt: string) => RpcClient & { userId(): Promise<string | null> }
  llm?: LlmCaller | null
}

export function llmFromEnv(env: Env, fetchImpl?: typeof fetch): LlmCaller | null {
  const baseUrl = env('LLM_BASE_URL')
  const apiKey = env('LLM_API_KEY')
  const model = env('LLM_MODEL')
  if (!baseUrl || !apiKey || !model) return null
  return createLlm({ baseUrl, apiKey, model, timeoutMs: Number(env('LLM_TIMEOUT_MS') ?? 20000),
    jsonResponseFormat: env('LLM_JSON_RESPONSE_FORMAT') !== 'false' }, fetchImpl)
}

export function createAiHandler(deps: AiDeps) {
  const { env, service } = deps
  const llm = deps.llm === undefined ? llmFromEnv(env) : deps.llm
  const mode = (env('LLM_TOOL_MODE') ?? 'auto') as 'auto' | 'tools' | 'json'
  const tenantDaily = Number(env('LLM_TENANT_DAILY_TOKENS') ?? 200_000)
  const globalDaily = Number(env('LLM_GLOBAL_DAILY_TOKENS') ?? 2_000_000)

  return async (req: Request): Promise<Response> => {
    const cors = corsHeaders(req.headers.get('origin'), env)
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    try {
      if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed')
      const parsed = Body.safeParse(await readJson(req))
      if (!parsed.success) throw new HttpError(400, 'invalid_request', parsed.error.issues[0]?.path.join('.'))
      const b = parsed.data
      const ipHash = (await sha256Hex(`${env('IP_HASH_SALT') ?? 'local'}:${clientIp(req, env)}`)).slice(0, 32)

      let tenant: TenantContext
      let owner: RpcClient | undefined
      if (b.scope === 'owner') {
        const jwt = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
        if (!jwt) throw new HttpError(401, 'auth_required')
        const uc = deps.userClient(jwt)
        const userId = await uc.userId()
        if (!userId) throw new HttpError(401, 'auth_required')
        const mine = await call<Array<TenantContext & { slug: string }>>(uc, 'owner_tenants')
        const t = mine.find((x) => x.slug === b.slug)
        if (!t) throw new HttpError(403, 'forbidden')
        tenant = { id: t.id, slug: t.slug, name: t.name, timezone: t.timezone, currency: t.currency }
        owner = uc
        await enforceRateLimits(service, [{ bucket: `user:${userId}:ai`, limit: 60, windowSeconds: 600 }])
      } else {
        await enforceRateLimits(service, [{ bucket: `ip:${ipHash}:ai`, limit: 20, windowSeconds: 600 }])
        const c = await call<any>(service, 'public_catalog', { p_slug: b.slug })
        tenant = { id: c.tenant.id, slug: c.tenant.slug, name: c.tenant.name, timezone: c.tenant.timezone, currency: c.tenant.currency }
        if (c.tenant.profile?.ai?.enabled === false) throw new HttpError(404, 'assistant_disabled')
      }

      const ctx: ToolContext = {
        scope: b.scope, tenant, service, owner, now: new Date(),
        orderAccess: b.scope === 'client' && b.order ? { orderId: b.order.id, token: b.order.token } : undefined,
      }
      const out = await runAssistant({
        ctx, history: b.messages, llm, mode,
        budget: {
          reserve: (tokens) => call<boolean>(service, 'llm_budget_reserve', {
            p_tenant: tenant.id, p_tokens: tokens, p_tenant_daily: tenantDaily, p_global_daily: globalDaily }),
          commit: (reserved, actual) => call(service, 'llm_budget_commit', { p_tenant: tenant.id, p_reserved: reserved, p_actual: actual }).then(() => {}),
        },
      })
      return json(out, 200, cors)
    } catch (e) {
      return errorResponse(e, cors)
    }
  }
}
