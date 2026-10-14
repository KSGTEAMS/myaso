import { createClient } from '@supabase/supabase-js'
import { createDispatchHandler } from './handler.ts'

const env = (k: string) => Deno.env.get(k)
const service = createClient(env('SUPABASE_URL')!, env('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
})

Deno.serve(createDispatchHandler({ env, service }))
