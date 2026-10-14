import { z } from 'zod'

const Env = z.object({
  VITE_SUPABASE_URL: z.url(),
  VITE_SUPABASE_ANON_KEY: z.string().min(20),
  VITE_VAPID_PUBLIC_KEY: z.string().optional(),
})

const parsed = Env.safeParse(import.meta.env)
if (!parsed.success) {
  throw new Error(`Missing frontend configuration: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}. See .env.example.`)
}

export const env = {
  supabaseUrl: parsed.data.VITE_SUPABASE_URL.replace(/\/$/, ''),
  anonKey: parsed.data.VITE_SUPABASE_ANON_KEY,
  vapidPublicKey: parsed.data.VITE_VAPID_PUBLIC_KEY ?? '',
}
