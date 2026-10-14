import { describe, expect, it } from 'vitest'
import { buildIcs } from '../../supabase/functions/_shared/ics.ts'
import {
  b64urlDecode, b64urlEncode, decryptPayload, encryptPayload, generateVapidKeys, sendPush, vapidAuthorization,
} from '../../supabase/functions/_shared/webpush.ts'

async function browserSubscription() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  const auth = crypto.getRandomValues(new Uint8Array(16))
  return { pair, raw, auth, keys: { p256dh: b64urlEncode(raw), auth: b64urlEncode(auth) } }
}

describe('web push', () => {
  it('aes128gcm payload decrypts on the receiver side', async () => {
    const sub = await browserSubscription()
    const msg = new TextEncoder().encode(JSON.stringify({ title: 'Новый заказ №7', body: 'Выдача 15 октября' }))
    const body = await encryptPayload(msg, sub.keys)
    expect(new DataView(body.buffer).getUint32(16)).toBe(4096)
    expect(body[20]).toBe(65)
    const plain = await decryptPayload(body, sub.pair.privateKey, sub.raw, sub.auth)
    expect(new TextDecoder().decode(plain)).toBe(new TextDecoder().decode(msg))
  })

  it('VAPID JWT is a valid ES256 signature for the push service origin', async () => {
    const keys = { ...(await generateVapidKeys()), subject: 'mailto:test@example.com' }
    const header = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys)
    const [, t, k] = header.match(/^vapid t=([^,]+), k=(.+)$/)!
    expect(k).toBe(keys.publicKey)
    const [h, c, s] = t!.split('.')
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(c!)))
    expect(claims.aud).toBe('https://fcm.googleapis.com')
    const pub = await crypto.subtle.importKey('raw', b64urlDecode(keys.publicKey) as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, b64urlDecode(s!) as BufferSource, new TextEncoder().encode(`${h}.${c}`))
    expect(ok).toBe(true)
  })

  it('reports gone subscriptions (404/410) separately from failures', async () => {
    const sub = await browserSubscription()
    const keys = { ...(await generateVapidKeys()), subject: 'mailto:test@example.com' }
    const seen: RequestInit[] = []
    const fake = (status: number) => (async (_u: string | URL | Request, init?: RequestInit) => { seen.push(init!); return new Response(null, { status }) }) as typeof fetch
    expect(await sendPush({ endpoint: 'https://push.example/a', ...sub.keys }, { a: 1 }, keys, {}, fake(201))).toEqual({ ok: true, status: 201, gone: false })
    expect(await sendPush({ endpoint: 'https://push.example/a', ...sub.keys }, { a: 1 }, keys, {}, fake(410))).toEqual({ ok: false, status: 410, gone: true })
    expect((seen[0]!.headers as Record<string, string>)['Content-Encoding']).toBe('aes128gcm')
  })
})

describe('ics', () => {
  it('builds a folded RFC 5545 event with a 2h alarm and cancellation', () => {
    const order = { id: 'o1', number: 12, status: 'confirmed', pickup_at: '2026-10-20T15:00:00Z', version: 3,
      items: [{ name: 'Рибай сухого вызревания, толстый край', quantity: 1.5, unit: 'kg' }], tenant: { name: 'Мясная, лавка', slug: 'shop' } }
    const ics = buildIcs(order, 'https://example.com/s/shop/', new Date('2026-10-14T00:00:00Z'))
    expect(ics).toContain('DTSTART:20261020T150000Z')
    expect(ics).toContain('SEQUENCE:3')
    expect(ics).toContain('TRIGGER:-PT2H')
    expect(ics).toContain('Мясная\\, лавка')
    for (const line of ics.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75)
    expect(buildIcs({ ...order, status: 'cancelled' }, 'u')).toContain('STATUS:CANCELLED')
  })
})
