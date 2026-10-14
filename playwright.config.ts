import { defineConfig, devices } from '@playwright/test'

// Requires the local stack (`npm run local:start`) and a build (`npm run build`).
// The built site is served with the same _redirects/_headers as Cloudflare Pages.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  projects: [{ name: 'mobile', use: { ...devices['Pixel 7'] } }],
  webServer: {
    command: 'npx tsx scripts/serve-dist.ts 4173',
    url: 'http://127.0.0.1:4173/tenants.json',
    reuseExistingServer: true,
  },
})
