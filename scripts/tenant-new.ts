// npm run tenant:new -- --slug <slug> --name "<Название>" [--from <existing-slug>]
//                      [--timezone Europe/Moscow] [--accent #RRGGBB]
// Scaffolds tenants/<slug>/ with business.json and placeholder images. Edit
// the JSON, replace the images with real photos, then validate and publish.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { arg } from './lib/env.ts'
import { renderArt } from './lib/art.ts'
import { tenantDir } from './lib/tenant.ts'
import { writeJsonSchema } from './tenant-validate.ts'

const STARTER = (slug: string, name: string, tz: string, accent: string) => ({
  $schema: '../business.schema.json',
  slug, name, short_name: name.slice(0, 12), locale: 'ru-RU', timezone: tz, currency: 'RUB',
  brand: { accent, background: '#0E0E10', tagline: 'Свежее мясо к удобному времени',
    description: 'Соберём заказ к выбранному времени — заберите без очереди.', hero_image: 'hero.jpg', icon_letter: name.slice(0, 1).toUpperCase() },
  contacts: { phone: '+70000000000', address: 'Город, улица, дом' },
  ordering: { pickup_step_minutes: 30, min_notice_minutes: 60, horizon_days: 14, cancel_notice_minutes: 120, max_order_lines: 20, payment_note: 'Оплата при получении' },
  hours: { mon: [['10:00', '20:00']], tue: [['10:00', '20:00']], wed: [['10:00', '20:00']], thu: [['10:00', '20:00']], fri: [['10:00', '20:00']], sat: [['10:00', '18:00']], sun: [] },
  exceptions: [],
  resources: [{ key: 'table-1', name: 'Разделочный стол', kind: 'cutting_table' }],
  prep_profiles: [{ key: 'cut', name: 'Разделка', base_minutes: 15, per_kg_minutes: 5, buffer_minutes: 10, resources: ['table-1'] }],
  categories: [{ key: 'beef', name: 'Говядина' }],
  products: [{ key: 'steak', category: 'beef', prep: 'cut', name: 'Стейк', description: '', unit: 'kg', price: 2500, qty_step: 0.5, min_qty: 0.5, max_qty: 5, image: 'steak.jpg' }],
  ai: { enabled: true },
})

async function main() {
  const slug = arg('slug')
  const name = arg('name')
  if (!slug || !name || !/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug)) {
    console.error('usage: npm run tenant:new -- --slug <slug> --name "<Name>" [--from <slug>] [--timezone Area/City] [--accent #RRGGBB]')
    process.exit(1)
  }
  const dir = tenantDir(slug)
  if (existsSync(dir)) { console.error(`tenants/${slug} already exists`); process.exit(1) }
  mkdirSync(path.join(dir, 'images'), { recursive: true })
  const from = arg('from')
  if (from) {
    const src = JSON.parse(readFileSync(path.join(tenantDir(from), 'business.json'), 'utf8'))
    Object.assign(src, { slug, name, short_name: name.slice(0, 12) })
    if (arg('timezone')) src.timezone = arg('timezone')
    if (arg('accent')) src.brand.accent = arg('accent')
    delete src.owner
    writeFileSync(path.join(dir, 'business.json'), `${JSON.stringify(src, null, 2)}\n`)
    for (const f of readdirSync(path.join(tenantDir(from), 'images'))) copyFileSync(path.join(tenantDir(from), 'images', f), path.join(dir, 'images', f))
  } else {
    writeFileSync(path.join(dir, 'business.json'), `${JSON.stringify(STARTER(slug, name, arg('timezone') ?? 'Europe/Moscow', arg('accent') ?? '#E4572E'), null, 2)}\n`)
    await renderArt('hero', `${slug}-hero`, path.join(dir, 'images', 'hero.jpg'), 1600, 1000)
    await renderArt('steak', `${slug}-steak`, path.join(dir, 'images', 'steak.jpg'))
  }
  writeJsonSchema()
  console.log(`created tenants/${slug}\nnext: edit tenants/${slug}/business.json, replace images, then\n  npm run tenant:validate -- ${slug}\n  npm run tenant:publish -- ${slug} --demo`)
}

main().catch((e) => { console.error(e.message); process.exit(1) })
