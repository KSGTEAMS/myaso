// Deterministic pre-router. It decides which server tools MUST run before the
// model answers, so any answer about orders, schedule or money is grounded in
// a fresh tool result even if the model would not have called a tool itself.
import type { Scope } from './types.ts'

export type Period = 'today' | 'yesterday' | 'tomorrow' | 'week' | 'last7' | 'month'

export type Intent =
  | 'owner_stats' | 'owner_schedule' | 'owner_find'
  | 'client_order' | 'client_slots' | 'client_catalog' | 'client_info'
  | 'general'

export interface PlannedCall { tool: string; args: Record<string, unknown> }
export interface Route { intent: Intent; calls: PlannedCall[]; period?: Period }

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е')

export function extractPeriod(text: string, fallback: Period = 'today'): Period {
  const t = norm(text)
  if (/позавчера/.test(t)) return fallback
  if (/вчера/.test(t)) return 'yesterday'
  if (/завтра/.test(t)) return 'tomorrow'
  if (/(7|семь)\s*дн|последн[а-яa-z]* недел|за неделю/.test(t)) return 'last7'
  if (/(эт[а-яa-z]*|текущ[а-яa-z]*) недел|на неделе|неделя/.test(t)) return 'week'
  if (/месяц/.test(t)) return 'month'
  if (/сегодня|сейчас|на день/.test(t)) return 'today'
  return fallback
}

const ORDER_NUMBER = /(?:№|номер|заказ)\s*#?\s*(\d{1,6})\b/
const PHONE = /\+?\d[\d\s()-]{8,}\d/

export function routeMessage(scope: Scope, message: string, opts: { hasOrderAccess?: boolean } = {}): Route {
  const t = norm(message)
  if (scope === 'owner') {
    const num = t.match(ORDER_NUMBER)?.[1]
    const phone = message.match(PHONE)?.[0]
    if (num || phone || /найди|найти|поиск/.test(t)) {
      const query = num ?? phone?.replace(/\D/g, '') ?? message.replace(/.*(найди|найти)\s*/i, '').slice(0, 60)
      return { intent: 'owner_find', calls: [{ tool: 'find_orders', args: { query } }] }
    }
    if (/выручк|оплат|платеж|получил|получено|деньг|заработ|касс|статистик|итог|сколько\s+(всего\s+)?(выдал|выдано|продал|заказ)|визит|пришл|не пришл|загрузк|отмен/.test(t)) {
      const period = extractPeriod(t)
      return { intent: 'owner_stats', period, calls: [{ tool: 'stats', args: { period } }] }
    }
    if (/заказ|выдач|расписан|план|забер|кто\s+(придет|будет)|блокир|коптильн|стол|камер/.test(t)) {
      const period = extractPeriod(t)
      return { intent: 'owner_schedule', period, calls: [{ tool: 'schedule', args: { period } }] }
    }
    return { intent: 'general', calls: [] }
  }

  if (/(мо[йего]{1,3}|моем|мой)\s+заказ|статус|отмен|перенес|перенест|когда\s+(мне\s+)?(забирать|приходить)|собран|готов ли/.test(t)) {
    return { intent: 'client_order', calls: opts.hasOrderAccess ? [{ tool: 'my_order', args: {} }] : [] }
  }
  if (/адрес|где\s+(вы|находит|забира)|час[а-яa-z]* работ|работаете|телефон|открыт|выходн|оплат/.test(t)) {
    return { intent: 'client_info', calls: [{ tool: 'shop_info', args: {} }] }
  }
  if (/когда\s+(можно\s+)?(забрать|будет|получ)|свободн|время\s+выдачи|ближайш|успеете|к\s+\d{1,2}[:.]?\d{0,2}/.test(t)) {
    return { intent: 'client_slots', calls: [{ tool: 'catalog', args: {} }] }
  }
  if (/цен|стоит|сколько|есть ли|в наличии|ассортимент|что (у вас )?есть|посовет|стейк|фарш|ребр|колбас|копч|вырез|баран|говяд|свин|кур|дичь|оленин/.test(t)) {
    return { intent: 'client_catalog', calls: [{ tool: 'catalog', args: {} }] }
  }
  return { intent: 'general', calls: [] }
}
