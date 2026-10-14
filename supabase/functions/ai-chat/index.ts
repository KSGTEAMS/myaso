import { createClient } from '@supabase/supabase-js'
import { createAiHandler } from './handler.ts'

const env = (k: string) => Deno.env.get(k)
const url = env('SUPABASE_URL')!
const service = createClient(url, env('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
})

function userClient(jwt: string) {
  const c = createClient(url, env('SUPABASE_ANON_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  })
  return Object.assign(c, {
    async userId() {
      const { data } = await c.auth.getUser(jwt)
      return data.user?.id ?? null
    },
  })
}

Deno.serve(createAiHandler({ env, service, userClient }))
