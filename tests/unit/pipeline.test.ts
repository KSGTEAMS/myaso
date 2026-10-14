import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BusinessSchema, contrastRatio, crossCheck, onAccent } from '../../shared/business-schema.ts'
import { buildPayload, loadBusiness, manifest, mediaPaths, renderShell } from '../../scripts/lib/tenant.ts'
import { REDIRECTS } from '../../scripts/build-shells.ts'

const raw = JSON.parse(readFileSync(path.resolve('tenants/rebro/business.json'), 'utf8'))
const parse = (patch: (b: any) => void) => { const b = structuredClone(raw); patch(b); return BusinessSchema.safeParse(b) }

describe('business.json validation', () => {
  it('accepts both demo tenants', () => {
    for (const slug of ['rebro', 'taiga']) expect(loadBusiness(slug).problems).toEqual([])
  })

  it('rejects broken input with readable paths', () => {
    expect(parse((b) => { b.timezone = 'Mars/Olympus' }).success).toBe(false)
    expect(parse((b) => { b.brand.accent = 'red' }).success).toBe(false)
    expect(parse((b) => { b.hours.mon = [['21:00', '10:00']] }).success).toBe(false)
    expect(parse((b) => { b.contacts.phone = '8 495' }).success).toBe(false)
  })

  it('cross-checks references and business rules', () => {
    const b = BusinessSchema.parse(structuredClone(raw))
    b.products[0]!.prep = 'nope'
    b.prep_profiles[0]!.resources.push('ghost')
    b.products[1]!.min_qty = 0.3
    b.brand.accent = '#151515'
    const msgs = crossCheck(b).map((p) => p.message)
    expect(msgs).toEqual(expect.arrayContaining(['unknown prep profile "nope"', 'unknown resource "ghost"',
      'min_qty must be a multiple of qty_step']))
    expect(msgs.some((m) => m.startsWith('accent contrast'))).toBe(true)
  })

  it('picks readable text colour on the accent', () => {
    expect(onAccent('#E4572E')).toBe('#000000')
    expect(onAccent('#1D3B8F')).toBe('#FFFFFF')
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21)
  })
})

describe('payload and site artefacts', () => {
  const b = loadBusiness('rebro').business!
  const payload = buildPayload(b, mediaPaths('rebro', b))

  it('is deterministic and converts money to minor units', () => {
    expect(buildPayload(b, mediaPaths('rebro', b)).config_hash).toBe(payload.config_hash)
    expect(payload.products.find((p) => p.key === 'ribeye')!.price_cents).toBe(389000)
    expect(payload.hours.filter((h) => h.weekday === 6)).toEqual([{ weekday: 6, opens: '09:00', closes: '22:00' }])
    expect(payload.products[0]!.image_path).toMatch(/^static:\/t\/rebro\/media\/ribeye-[0-9a-f]{10}$/)
    const changed = structuredClone(b)
    changed.products[0]!.price = 3990
    expect(buildPayload(changed, mediaPaths('rebro', b)).config_hash).not.toBe(payload.config_hash)
  })

  it('separate manifests per tenant and per app', () => {
    const m = manifest(b, 'client')
    const o = manifest(b, 'owner')
    expect([m.id, m.scope]).toEqual(['/s/rebro/', '/s/rebro/'])
    expect([o.id, o.scope]).toEqual(['/s/rebro/owner/', '/s/rebro/owner/'])
    expect(m.icons.some((i) => i.purpose === 'maskable')).toBe(true)
    const t = loadBusiness('taiga').business!
    expect(manifest(t, 'client').id).not.toBe(m.id)
  })

  it('renders a shell with tenant meta and no business name in the shared template', () => {
    const template = readFileSync(path.resolve('index.html'), 'utf8')
    expect(template).not.toContain(b.name)
    const html = renderShell(template, b, 'owner')
    expect(html).toContain('<meta name="tenant-slug" content="rebro" />')
    expect(html).toContain('href="/t/rebro/owner.webmanifest"')
    expect(html).toContain('noindex')
    expect(html.match(/<title>/g)).toHaveLength(1)
  })

  it('routes deep links of any shop to that shop\'s shell', () => {
    expect(REDIRECTS).toContain('/s/:slug/* /s/:slug/index.html 200')
    expect(REDIRECTS.indexOf('/s/:slug/owner/*')).toBeLessThan(REDIRECTS.indexOf('/s/:slug/*'))
  })
})
