import type { RpcClient } from '../db.ts'

export type Scope = 'client' | 'owner'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
}

export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }

export interface TenantContext { id: string; slug: string; name: string; timezone: string; currency: string }

/**
 * Everything a tool may touch. The tenant is fixed by the server before the
 * model runs; the model can neither choose it nor write SQL.
 *  - client tools use `service` but only with this tenant's slug and, for
 *    "my order", the token that came with the request;
 *  - owner tools use `owner`, a client carrying the signed-in user's JWT, so
 *    membership is enforced again by SQL.
 */
export interface ToolContext {
  scope: Scope
  tenant: TenantContext
  service: RpcClient
  owner?: RpcClient
  orderAccess?: { orderId: string; token: string }
  now: Date
}

export interface ToolResult { ok: boolean; data?: unknown; error?: string }
