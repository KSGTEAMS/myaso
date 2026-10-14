// Two shops on one build: separate worker scopes, cache names, manifests and
// offline shells; API responses and owner data never land in worker caches.
import { expect, test } from '@playwright/test'

test('each shop gets its own worker scope, caches and shell (also offline)', async ({ page, context }) => {
  for (const slug of ['rebro', 'taiga']) {
    await page.goto(`/s/${slug}/`)
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
    await page.waitForFunction(async (s) => {
      const regs = await navigator.serviceWorker.getRegistrations()
      return regs.some((r) => r.active && new URL(r.scope).pathname === `/s/${s}/`)
    }, slug, { timeout: 15_000 })
    expect(await page.locator('link[rel="manifest"]').getAttribute('href')).toBe(`/t/${slug}/manifest.webmanifest`)
    expect(await page.locator('meta[name="tenant-slug"]').getAttribute('content')).toBe(slug)
  }
  const scopes = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map((r) => new URL(r.scope).pathname).sort())
  expect(scopes).toEqual(['/s/rebro/', '/s/taiga/'])

  await page.waitForTimeout(1000)
  const caches = await page.evaluate(async () => {
    const out: Record<string, string[]> = {}
    for (const name of await self.caches.keys()) out[name] = (await (await self.caches.open(name)).keys()).map((r) => r.url)
    return out
  })
  const names = Object.keys(caches)
  expect(names.some((n) => n.startsWith('shop-rebro-client'))).toBe(true)
  expect(names.some((n) => n.startsWith('shop-taiga-client'))).toBe(true)
  expect(names.every((n) => n.startsWith('shop-'))).toBe(true)
  const urls = Object.values(caches).flat()
  expect(urls.filter((u) => u.includes('/rest/v1') || u.includes('/functions/v1') || u.includes('/auth/v1'))).toEqual([])
  // rebro caches never contain taiga files and vice versa
  for (const [name, list] of Object.entries(caches)) {
    const other = name.includes('rebro') ? '/t/taiga/' : '/t/rebro/'
    expect(list.filter((u) => u.includes(other))).toEqual([])
  }

  // Offline deep link: the worker serves the right shop's shell.
  await context.setOffline(true)
  await page.goto('/s/taiga/orders/00000000-0000-4000-8000-000000000000')
  expect(await page.locator('meta[name="tenant-slug"]').getAttribute('content')).toBe('taiga')
  await expect(page.getByText(/Не удалось|Нет доступа|Нет соединения/).first()).toBeVisible()
  await context.setOffline(false)
})

test('owner cabinet registers its own scope and leaves no private data after logout', async ({ page }) => {
  await page.goto('/s/rebro/owner/')
  await page.getByLabel('E-mail').fill('owner@rebro.demo')
  await page.getByLabel('Пароль').fill('demo-rebro-owner')
  await page.getByRole('button', { name: 'Войти' }).click()
  await expect(page.getByRole('heading', { name: 'Выдача' })).toBeVisible()
  await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistrations()).some((r) => new URL(r.scope).pathname === '/s/rebro/owner/'), null, { timeout: 15_000 })
  expect(await page.locator('link[rel="manifest"]').getAttribute('href')).toBe('/t/rebro/owner.webmanifest')

  await page.goto('/s/rebro/owner/more')
  await page.getByRole('button', { name: 'Выйти' }).click()
  await expect(page.getByRole('button', { name: 'Войти' })).toBeVisible()
  const leftovers = await page.evaluate(async () => {
    const urls: string[] = []
    for (const name of await caches.keys()) for (const r of await (await caches.open(name)).keys()) urls.push(r.url)
    return { urls, storage: Object.keys(localStorage) }
  })
  expect(leftovers.urls.filter((u) => /rest\/v1|functions\/v1|auth\/v1|storage\/v1/.test(u))).toEqual([])
  expect(leftovers.storage.filter((k) => k.startsWith('owner-session'))).toEqual([])
})
