// Formatting in the shop's timezone: the customer may be elsewhere, but
// pickup times are always shown as shop-local wall clock.

export function money(cents: number, currency = 'RUB'): string {
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency, maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100)
}

export function qty(q: number, unit: 'kg' | 'pcs'): string {
  return unit === 'kg' ? `${q.toLocaleString('ru-RU', { maximumFractionDigits: 3 })} кг` : `${q} шт`
}

export const unitLabel = (unit: 'kg' | 'pcs') => (unit === 'kg' ? 'кг' : 'шт')

export function dateTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))
}

export function time(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date(iso))
}

export function dayLabel(localDate: string): { weekday: string; day: string; month: string } {
  const d = new Date(`${localDate}T12:00:00Z`)
  const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', ...o }).format(d)
  return { weekday: f({ weekday: 'short' }), day: f({ day: 'numeric' }), month: f({ month: 'short' }) }
}

export function localToday(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

export function addDays(localDate: string, n: number): string {
  const d = new Date(`${localDate}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export function minutesLabel(min: number): string {
  if (min >= 1440) {
    const days = Math.round((min / 1440) * 10) / 10
    return `${days.toLocaleString('ru-RU')} ${days === 1 ? 'сутки' : 'сут.'}`
  }
  if (min >= 60) return `${Math.floor(min / 60)} ч${min % 60 ? ` ${min % 60} мин` : ''}`
  return `${min} мин`
}

export const STATUS_LABEL: Record<string, string> = {
  confirmed: 'Принят', ready: 'Собран', completed: 'Выдан', cancelled: 'Отменён', no_show: 'Не забран',
}

/** Local datetime-local input value (shop timezone) <-> ISO instant. */
export function toLocalInput(iso: string, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(iso)).reduce<Record<string, string>>((a, p) => ({ ...a, [p.type]: p.value }), {})
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
}

export function fromLocalInput(value: string, tz: string): string {
  // Find the instant whose wall clock in tz equals `value` (two passes handle DST).
  const target = Date.parse(`${value}:00Z`)
  let guess = target
  for (let i = 0; i < 2; i++) {
    const wall = Date.parse(`${toLocalInput(new Date(guess).toISOString(), tz)}:00Z`)
    guess += target - wall
  }
  return new Date(guess).toISOString()
}
