import { afterAll, describe, expect, it } from 'vitest'
import { createTenant, customer, expectFail, key, pool, q, ribeye, rpc } from './helpers.ts'

afterAll(() => pool.end())

const localDate = (d: Date, tz: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)

describe('timezones, exceptions and date boundaries', () => {
  it('produces slots on the local grid in the tenant timezone', async () => {
    const tz = 'Asia/Novosibirsk'
    const f = await createTenant({ timezone: tz, opens: '10:00', closes: '18:00' })
    const res = await rpc('get_pickup_slots', { p_slug: f.slug, p_items: ribeye(f), p_from: null, p_to: null })
    expect(res.timezone).toBe(tz)
    for (const s of res.slots as Array<{ pickup_at: string; local_time: string; local_date: string }>) {
      const local = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false })
        .format(new Date(s.pickup_at))
      expect(local).toBe(s.local_time)
      expect(s.local_date).toBe(localDate(new Date(s.pickup_at), tz))
      expect(s.local_time >= '10:00' && s.local_time < '18:00').toBe(true)
      expect(['00', '30']).toContain(s.local_time.slice(3))
    }
    // First pickup of a day needs the 35 min preparation inside opening hours.
    expect(res.slots.some((s: { local_time: string }) => s.local_time === '10:00')).toBe(false)
  })

  it('honours closed days and replacement hours', async () => {
    const tz = 'Europe/Moscow'
    const today = localDate(new Date(), tz)
    const d1 = new Date(Date.parse(today) + 2 * 86400_000).toISOString().slice(0, 10)
    const d2 = new Date(Date.parse(today) + 3 * 86400_000).toISOString().slice(0, 10)
    const f = await createTenant({ timezone: tz, exceptions: [
      { day: d1, is_closed: true },
      { day: d2, opens: '12:00', closes: '14:00' },
    ] })
    const res = await rpc('get_pickup_slots', { p_slug: f.slug, p_items: ribeye(f), p_from: d1, p_to: d2 })
    const byDay = (d: string) => (res.slots as Array<{ local_date: string; local_time: string }>).filter((s) => s.local_date === d)
    expect(byDay(d1)).toEqual([])
    // 12:30 would need preparation from 11:55, before the shop opens that day.
    expect(byDay(d2).map((s) => s.local_time)).toEqual(['13:00', '13:30'])
  })

  it('keeps local wall-clock hours across a DST change', async () => {
    const f = await createTenant({ timezone: 'America/New_York', opens: '10:00', closes: '11:00' })
    // 2026-11-01 is the US fall-back day.
    const rows = await q<{ d: string; opens: Date }>(
      `select d::text, w.opens from unnest(array['2026-10-31'::date, '2026-11-01'::date]) d,
       lateral private.pickup_windows($1, d) w order by d`, [f.tenantId])
    expect(rows.map((r) => r.opens.toISOString())).toEqual(['2026-10-31T14:00:00.000Z', '2026-11-01T15:00:00.000Z'])
  })

  it('limits the range to the horizon and never returns past slots', async () => {
    const f = await createTenant()
    const res = await rpc('get_pickup_slots', { p_slug: f.slug, p_items: ribeye(f), p_from: '2000-01-01', p_to: '2100-01-01' })
    const times = (res.slots as Array<{ pickup_at: string }>).map((s) => Date.parse(s.pickup_at))
    expect(Math.min(...times)).toBeGreaterThan(Date.now())
    expect(Math.max(...times)).toBeLessThanOrEqual(Date.now() + 31 * 86400_000)
    expect(Date.parse(res.to) - Date.parse(res.from)).toBeLessThanOrEqual(13 * 86400_000)
  })

  it('refuses a pickup in the past even for an exact grid moment', async () => {
    const f = await createTenant()
    await expectFail(rpc('place_order', { p_slug: f.slug, p_items: ribeye(f), p_pickup_at: '2020-01-01T10:00:00Z',
      p_customer: customer(1), p_idempotency_key: key() }), 'slot_unavailable')
  })
})
