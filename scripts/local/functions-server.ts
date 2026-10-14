// Local Edge Functions runtime (Deno). Serves every function at
// /<name> on one port using the same handler modules as production
// (each production index.ts only wires real dependencies to its handler).
import { createClient } from 'npm:@supabase/supabase-js@2.117.3'
import { createPublicApiHandler } from '../../supabase/functions/public-api/handler.ts'
import { createAiHandler } from '../../supabase/functions/ai-chat/handler.ts'
import { createDispatchHandler } from '../../supabase/functions/notify-dispatch/handler.ts'

const env = (k: string) => Deno.env.get(k)
const url = env('SUPABASE_URL')!
const service = createClient(url, env('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } })
const userClient = (jwt: string) => {
  const c = createClient(url, env('SUPABASE_ANON_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  })
  return Object.assign(c, { async userId() { const { data } = await c.auth.getUser(jwt); return data.user?.id ?? null } })
}

const handlers: Record<string, (req: Request) => Promise<Response>> = {
  'public-api': createPublicApiHandler({ env, service }),
  'ai-chat': createAiHandler({ env, service, userClient }),
  'notify-dispatch': createDispatchHandler({ env, service }),
}

Deno.serve({ port: Number(env('FUNCTIONS_PORT') ?? 54333), hostname: '127.0.0.1' }, (req) => {
  const name = new URL(req.url).pathname.split('/').filter(Boolean)[0] ?? ''
  const h = handlers[name]
  return h ? h(req) : Promise.resolve(new Response(JSON.stringify({ error: 'function_not_found' }), { status: 404 }))
})
