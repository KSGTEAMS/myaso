// Deterministic answers from tool results, used when the LLM is disabled,
// unreachable or over budget. Ordinary ordering never depends on the model.
import type { Intent } from './router.ts'
import type { ToolResult } from './types.ts'

const rub = (v: number, currency = 'RUB') =>
  new Intl.NumberFormat('ru-RU', { style: 'currency', currency, maximumFractionDigits: 0 }).format(v)

const PERIOD_LABEL: Record<string, string> = {
  today: 'сегодня', yesterday: 'вчера', tomorrow: 'завтра', week: 'эта неделя', last7: 'последние 7 дней', month: 'этот месяц',
}

export function fmtTime(iso: string, tz: string) {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))
}

export function fallbackAnswer(intent: Intent, results: Array<{ tool: string; result: ToolResult }>, tz: string): string {
  const r = results.find((x) => x.result.ok)
  if (!r) {
    if (intent === 'client_order') return 'Откройте ссылку на свой заказ (она пришла после оформления) — там видно статус и время выдачи.'
    return 'Ассистент сейчас недоступен. Каталог, оформление и ваши заказы работают как обычно.'
  }
  const d = r.result.data as any
  switch (r.tool) {
    case 'stats':
      return [`Период: ${PERIOD_LABEL[d.bounds.period] ?? `${d.bounds.from_date} — ${d.bounds.to_date}`} (${d.bounds.timezone}).`,
        `Визиты за заказами: ${d.visits}.`,
        `Выдано заказов: ${d.completed_orders.count} на ${rub(d.completed_orders.value, d.currency)}.`,
        `Получено оплат: ${rub(d.payments_received.net, d.currency)} (${d.payments_received.count} платеж.).`,
        `Ещё ожидается к выдаче: ${d.expected_pickups_not_revenue.count} на ${rub(d.expected_pickups_not_revenue.value, d.currency)} — это не выручка.`].join('\n')
    case 'schedule':
      if (!d.total) return `На период ${PERIOD_LABEL[d.bounds.period] ?? ''} заказов нет.`
      return [`Заказов к выдаче (${PERIOD_LABEL[d.bounds.period] ?? d.bounds.from_date}): ${d.total}.`,
        ...d.orders.slice(0, 10).map((o: any) => `№${o.number} · ${fmtTime(o.pickup_at, tz)} · ${o.customer} · ${o.items.join(', ')}`)].join('\n')
    case 'find_orders':
      if (!d.found) return 'Ничего не нашёл.'
      return d.orders.map((o: any) => `№${o.number} · ${fmtTime(o.pickup_at, tz)} · ${o.status} · ${o.customer}`).join('\n')
    case 'my_order':
      if (!d.available) return d.reason
      return `Заказ №${d.number}: ${STATUS[d.status] ?? d.status}, выдача ${fmtTime(d.pickup_at, tz)}.`
        + (d.can_change ? ' Изменить или отменить можно на странице заказа.' : '')
    case 'shop_info':
      return [d.contacts.address && `Самовывоз: ${d.contacts.address}.`, d.contacts.phone && `Телефон: ${d.contacts.phone}.`]
        .filter(Boolean).join(' ') || d.name
    case 'catalog':
      return d.products.slice(0, 8).map((p: any) => `${p.name} — ${rub(p.price, d.currency)}/${p.unit === 'kg' ? 'кг' : 'шт'}`).join('\n')
    case 'pickup_slots':
      return d.first_slots.length ? `Ближайшее время выдачи: ${d.first_slots.slice(0, 4).join(', ')}.` : 'Свободного времени выдачи в ближайшие дни нет.'
  }
  return 'Готово.'
}

const STATUS: Record<string, string> = {
  confirmed: 'принят', ready: 'собран и ждёт вас', completed: 'выдан', cancelled: 'отменён', no_show: 'не забран',
}
