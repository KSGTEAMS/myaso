// From choosing a product to the confirmation, then the order appears in the
// owner cabinet. Runs against the real local stack (no mocks).
import { expect, test } from '@playwright/test'

const SLUG = 'rebro'
const OWNER = { email: 'owner@rebro.demo', password: 'demo-rebro-owner' }

test('customer orders for pickup and the owner sees the order', async ({ page, browser }) => {
  const customer = `Покупатель E2E ${Date.now().toString().slice(-5)}`

  await page.goto(`/s/${SLUG}/`)
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
  // Product sheet: open, add, close via the sheet button
  await page.getByRole('button', { name: /Рибай, зерновой откорм, подробнее/ }).click()
  const sheet = page.getByRole('dialog')
  await expect(sheet.getByRole('heading', { name: 'Рибай, зерновой откорм' })).toBeVisible()
  await sheet.getByRole('button', { name: /^Добавить/ }).click()
  await expect(sheet).toBeHidden()

  await page.getByRole('link', { name: /Корзина ·/ }).click()
  await expect(page).toHaveURL(new RegExp(`/s/${SLUG}/cart$`))
  // Pick the first offered pickup time (server-computed availability).
  const slots = page.getByRole('radiogroup', { name: 'Время выдачи' })
  await expect(slots.getByRole('button').first()).toBeVisible()
  await slots.getByRole('button').first().click()
  await page.getByLabel('Имя').fill(customer)
  await page.getByLabel('Телефон').fill('+7 900 555-44-33')
  await page.getByRole('button', { name: /^Заказать к/ }).click()

  await expect(page.getByText('Заказ принят')).toBeVisible()
  const title = await page.getByRole('heading', { level: 1 }).textContent()
  const number = title!.match(/№(\d+)/)![1]!
  await expect(page).toHaveURL(new RegExp(`/s/${SLUG}/orders/[0-9a-f-]{36}$`))

  // The order is listed on this device and survives reload.
  await page.goto(`/s/${SLUG}/orders`)
  await expect(page.getByRole('link', { name: new RegExp(`Заказ №${number}`) })).toBeVisible()

  // ---- owner cabinet (separate browser context = separate device)
  const ownerCtx = await browser.newContext()
  const owner = await ownerCtx.newPage()
  await owner.goto(`/s/${SLUG}/owner/`)
  await owner.getByLabel('E-mail').fill(OWNER.email)
  await owner.getByLabel('Пароль').fill(OWNER.password)
  await owner.getByRole('button', { name: 'Войти' }).click()
  await expect(owner.getByRole('heading', { name: 'Выдача' })).toBeVisible()

  await owner.getByRole('link', { name: 'Заказы' }).click()
  await owner.getByPlaceholder('Номер, телефон или имя').fill(number)
  const row = owner.getByRole('link', { name: new RegExp(`№${number} · ${customer}`) })
  await expect(row).toBeVisible()
  await row.click()
  await expect(owner.getByRole('heading', { name: `Заказ №${number}` })).toBeVisible()
  await expect(owner.getByText('Рибай, зерновой откорм')).toBeVisible()
  // Owner marks it ready; the customer sees the new status.
  await owner.getByRole('button', { name: 'Собран — можно забирать' }).click()
  await expect(owner.getByText('Собран', { exact: true })).toBeVisible()
  await page.goto(`/s/${SLUG}/orders`)
  await expect(page.getByRole('listitem').filter({ hasText: `Заказ №${number}` }).getByText('Собран')).toBeVisible()

  // Logout clears the private session.
  await owner.goto(`/s/${SLUG}/owner/more`)
  await owner.getByRole('button', { name: 'Выйти' }).click()
  await expect(owner.getByRole('button', { name: 'Войти' })).toBeVisible()
  expect(await owner.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('owner-session')))).toEqual([])
  await ownerCtx.close()
})
