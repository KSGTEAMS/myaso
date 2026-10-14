// Notification texts. Times are rendered in the tenant timezone.

export interface OutboxJob {
  id: number
  kind: 'order_created' | 'order_rescheduled' | 'order_cancelled' | 'pickup_reminder' | 'order_ready'
  audience: 'owner' | 'client'
  order_id: string | null
  tenant: { slug: string; name: string; timezone: string }
  order: { number: number; pickup_at: string; status: string } | null
  targets: Array<{ id: string; endpoint: string; p256dh: string; auth: string }>
  attempts: number
}

export function formatLocal(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: tz, day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso))
}

export function notificationMessage(job: OutboxJob, appUrl: string) {
  const n = job.order?.number ?? ''
  const when = job.order ? formatLocal(job.order.pickup_at, job.tenant.timezone) : ''
  const base = `${appUrl.replace(/\/$/, '')}/s/${job.tenant.slug}`
  const ownerUrl = job.order_id ? `${base}/owner/orders/${job.order_id}` : `${base}/owner/`
  const clientUrl = `${base}/orders`
  switch (job.kind) {
    case 'order_created':
      return { title: `Новый заказ №${n}`, body: `Выдача ${when}`, url: ownerUrl, tag: `order-${job.order_id}` }
    case 'order_rescheduled':
      return { title: `Заказ №${n} перенесён`, body: `Новое время выдачи: ${when}`, url: ownerUrl, tag: `order-${job.order_id}` }
    case 'order_cancelled':
      return { title: `Заказ №${n} отменён`, body: `Был на ${when}`, url: ownerUrl, tag: `order-${job.order_id}` }
    case 'pickup_reminder':
      return { title: job.tenant.name, body: `Заказ №${n} ждёт вас ${when}`, url: clientUrl, tag: `order-${job.order_id}` }
    case 'order_ready':
      return { title: job.tenant.name, body: `Заказ №${n} собран — можно забирать`, url: clientUrl, tag: `order-${job.order_id}` }
  }
}
