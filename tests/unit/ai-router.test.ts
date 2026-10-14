import { describe, expect, it } from 'vitest'
import { extractPeriod, routeMessage } from '../../supabase/functions/_shared/ai/router.ts'

describe('AI pre-router (selected deterministic router)', () => {
  it.each([
    ['Сколько денег получили сегодня?', 'owner_stats', 'today'],
    ['Какая выручка за неделю', 'owner_stats', 'last7'],
    ['оплаты вчера', 'owner_stats', 'yesterday'],
    ['статистика за этот месяц', 'owner_stats', 'month'],
    ['сколько выдали на этой неделе', 'owner_stats', 'week'],
    ['Какие заказы на завтра?', 'owner_schedule', 'tomorrow'],
    ['кто придёт сегодня за заказом', 'owner_schedule', 'today'],
    ['что с коптильней', 'owner_schedule', 'today'],
  ])('owner: %s -> %s (%s)', (text, intent, period) => {
    const r = routeMessage('owner', text)
    expect(r.intent).toBe(intent)
    expect(r.period).toBe(period)
    expect(r.calls).toHaveLength(1)
  })

  it('owner: order number and phone go to find_orders', () => {
    expect(routeMessage('owner', 'покажи заказ №42').calls).toEqual([{ tool: 'find_orders', args: { query: '42' } }])
    expect(routeMessage('owner', 'найди +7 912 345-67-89').calls[0]).toEqual({ tool: 'find_orders', args: { query: '79123456789' } })
  })

  it('owner: small talk runs no tool', () => {
    expect(routeMessage('owner', 'привет').calls).toEqual([])
  })

  it('client: order questions use my_order only with order access', () => {
    expect(routeMessage('client', 'Какой статус моего заказа?', { hasOrderAccess: true }).calls).toEqual([{ tool: 'my_order', args: {} }])
    expect(routeMessage('client', 'Какой статус моего заказа?', { hasOrderAccess: false })).toEqual({ intent: 'client_order', calls: [] })
  })

  it('client: never routes to owner tools', () => {
    for (const t of ['выручка за неделю', 'заказы на завтра', 'найди заказ №5', 'сколько стоит рибай', 'адрес']) {
      const r = routeMessage('client', t)
      expect(r.calls.every((c) => ['catalog', 'pickup_slots', 'shop_info', 'my_order'].includes(c.tool))).toBe(true)
    }
  })

  it('client intents', () => {
    expect(routeMessage('client', 'Сколько стоит рибай?').intent).toBe('client_catalog')
    expect(routeMessage('client', 'Где вас найти, какой адрес?').intent).toBe('client_info')
    expect(routeMessage('client', 'Когда можно забрать брискет?').intent).toBe('client_slots')
  })

  it('period extraction defaults', () => {
    expect(extractPeriod('что сегодня')).toBe('today')
    expect(extractPeriod('что-то', 'week')).toBe('week')
    expect(extractPeriod('за последние 7 дней')).toBe('last7')
  })
})
