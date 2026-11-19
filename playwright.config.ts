import { defineConfig, devices } from '@playwright/test'

// End-to-end tests drive the real app in Google Chrome. They start their own
// dev server on a separate port, so its saved blueprints never mix with the
// ones in your everyday browser profile.
//
// `E2E_PROD=1` runs the same tests against the production build instead, which
// is what `npm run test:e2e:prod` does.
const PROD = !!process.env.E2E_PROD
const PORT = PROD ? 5198 : 5199

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
  timeout: 45_000,
  expect: { timeout: 6_000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 1440, height: 900 } }, testIgnore: /(responsive|performance)\.spec/ },
    { name: 'responsive', use: { ...devices['Desktop Chrome'], channel: 'chrome' }, testMatch: /responsive\.spec/ },
    // timing is only meaningful on a quiet machine, so these run one at a time after everything else has finished
    { name: 'performance', use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 1440, height: 900 } }, testMatch: /performance\.spec/, dependencies: ['desktop', 'responsive'] },
  ],
  webServer: {
    command: PROD ? `npx vite build && npx vite preview --port ${PORT} --strictPort` : `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
