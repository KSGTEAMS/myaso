// Astryx foundation check on real pages: if a stylesheet lands in the wrong
// cascade layer (e.g. a lazily split CSS chunk before the layer order), the
// components lose padding/background silently. This catches it.
import { expect, test, type Page } from '@playwright/test'

async function buttonStyle(page: Page, name: RegExp) {
  return page.getByRole('button', { name }).first().evaluate((el) => {
    const s = getComputedStyle(el)
    return { pad: s.paddingInline, bg: s.backgroundColor }
  })
}

test('Astryx components keep their styles on storefront and in the lazily loaded cabinet', async ({ page }) => {
  await page.goto('/s/rebro/')
  const add = await buttonStyle(page, /^В корзину$/)
  expect(add.pad).not.toBe('0px')
  expect(add.bg).not.toBe('rgba(0, 0, 0, 0)')

  await page.goto('/s/taiga/owner/')
  const login = await buttonStyle(page, /^Войти$/)
  expect(login.pad).not.toBe('0px')
  expect(login.bg).not.toBe('rgba(0, 0, 0, 0)')
  // the shop accent reaches the primary button (taiga accent is green)
  const [r, g] = login.bg.match(/\d+/g)!.map(Number)
  expect(g!).toBeGreaterThan(r!)
})
