// RFC 5545 calendar file for one pickup. An optional channel next to push:
// the customer's calendar app does the reminding.

function fmt(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

function escape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
}

/** Fold lines longer than 75 octets as required by RFC 5545. */
function fold(line: string): string {
  const bytes = new TextEncoder().encode(line)
  if (bytes.length <= 75) return line
  const out: string[] = []
  let cur = ''
  for (const ch of line) {
    if (new TextEncoder().encode(cur + ch).length > (out.length ? 74 : 75)) {
      out.push(cur)
      cur = ch
    } else cur += ch
  }
  out.push(cur)
  return out.join('\r\n ')
}

export interface IcsOrder {
  id: string
  number: number
  status: string
  pickup_at: string
  version: number
  items: Array<{ name: string; quantity: number; unit: string }>
  tenant: { name: string; slug: string }
}

export function buildIcs(order: IcsOrder, url: string, now = new Date()): string {
  const start = new Date(order.pickup_at)
  const end = new Date(start.getTime() + 15 * 60_000)
  const lines = order.items.map((i) => `${i.name} — ${i.quantity} ${i.unit === 'kg' ? 'кг' : 'шт'}`).join('\n')
  const cancelled = order.status === 'cancelled'
  const body = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//pickup-orders//RU',
    'CALSCALE:GREGORIAN',
    `METHOD:${cancelled ? 'CANCEL' : 'PUBLISH'}`,
    'BEGIN:VEVENT',
    `UID:order-${order.id}@pickup-orders`,
    `SEQUENCE:${order.version}`,
    `DTSTAMP:${fmt(now)}`,
    `DTSTART:${fmt(start)}`,
    `DTEND:${fmt(end)}`,
    `SUMMARY:${escape(`Забрать заказ №${order.number} — ${order.tenant.name}`)}`,
    `DESCRIPTION:${escape(`${lines}\n${url}`)}`,
    `URL:${escape(url)}`,
    `STATUS:${cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'TRIGGER:-PT2H',
    `DESCRIPTION:${escape(`Через 2 часа: заказ №${order.number}`)}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ]
  return body.map(fold).join('\r\n') + '\r\n'
}
