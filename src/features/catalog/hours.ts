import type { Shop } from '@/api/types'
import { localToday } from '@/lib/format'

const hm = (t: string | null) => (t ?? '').slice(0, 5)

/** "Сегодня 10:00–21:00" in the shop timezone, honouring date exceptions. */
export function todayHours(shop: Shop): string {
  const today = localToday(shop.tenant.timezone)
  const ex = shop.exceptions.filter((e) => e.day === today)
  if (ex.some((e) => e.is_closed)) return `Сегодня выходной${ex[0]?.note ? ` · ${ex[0].note}` : ''}`
  const list = ex.length ? ex.map((e) => `${hm(e.opens_at)}–${hm(e.closes_at)}`)
    : shop.hours.filter((h) => h.weekday === isoWeekday(today)).map((h) => `${hm(h.opens_at)}–${hm(h.closes_at)}`)
  return list.length ? `Выдача сегодня ${list.join(', ')}` : 'Сегодня выдачи нет'
}

export function isoWeekday(localDate: string): number {
  const d = new Date(`${localDate}T12:00:00Z`).getUTCDay()
  return d === 0 ? 7 : d
}

export const WEEKDAY_NAMES = ['', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']

export function weekHours(shop: Shop): Array<{ day: string; text: string }> {
  return [1, 2, 3, 4, 5, 6, 7].map((d) => {
    const h = shop.hours.filter((x) => x.weekday === d)
    return { day: WEEKDAY_NAMES[d]!, text: h.length ? h.map((x) => `${hm(x.opens_at)}–${hm(x.closes_at)}`).join(', ') : 'выходной' }
  })
}
