import { chromium, devices } from '@playwright/test'
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
const ctx = await b.newContext({ ...devices['iPhone 13'], defaultBrowserType: undefined })
const p = await ctx.newPage()
const logs = []
p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.text()) })
p.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message))
for (const [path, name] of process.argv.slice(2).map((a) => a.split('='))) {
  await p.goto('http://127.0.0.1:4173' + path, { waitUntil: 'networkidle' })
  await p.waitForTimeout(800)
  await p.screenshot({ path: `/tmp/claude-0/shots/${name}.png` })
}
console.log(logs.slice(0, 15).join('\n'))
await b.close()
