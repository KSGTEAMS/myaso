// npm run vapid:keys — prints a fresh VAPID key pair for Web Push.
import { generateVapidKeys } from '../supabase/functions/_shared/webpush.ts'

const k = await generateVapidKeys()
console.log(`VAPID_PUBLIC_KEY=${k.publicKey}\nVAPID_PRIVATE_KEY=${k.privateKey}\n# frontend:\nVITE_VAPID_PUBLIC_KEY=${k.publicKey}`)
