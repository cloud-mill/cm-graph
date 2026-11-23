import { defineConfig, devices } from '@playwright/test'

// End-to-end tests drive the real app in Google Chrome. They start their own
// dev server on a separate port, so its saved blueprints never mix with the
// ones in your everyday browser profile.
//
// `E2E_PROD=1` runs the same tests against the production build instead, which
// is what `npm run test:e2e:prod` does.
//
// The two runs have a port each, so neither can pick up a server left running by the other, and both keep
// clear of the everyday dev server on 5183 (vite.config.ts). Storage belongs to an origin, and a port of its
// own is what makes the tests a separate one.
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
    // copying a share link or an export is checked by reading the clipboard back
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  // A spec is given to projects by its file name:
  //   responsive.spec.ts                    -> responsive
  //   performance.spec.ts                   -> performance
  //   mobile.spec.ts and *.mobile.spec.ts   -> every phone project
  //   every other *.spec.ts                 -> desktop
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 1440, height: 900 } }, testIgnore: /(responsive|performance|mobile)\.spec/ },
    { name: 'responsive', use: { ...devices['Desktop Chrome'], channel: 'chrome' }, testMatch: /responsive\.spec/ },
    // phones: real device profiles (size, pixel ratio, touch, user agent) driven by Chrome's touch input.
    // The iPhone profiles name Safari's engine as their browser, so they are pointed back at Chrome
    { name: 'android', use: { ...devices['Pixel 7'], channel: 'chrome' }, testMatch: /mobile\.spec/ },
    { name: 'iphone', use: { ...devices['iPhone 15'], defaultBrowserType: 'chromium', channel: 'chrome' }, testMatch: /mobile\.spec/ },
    { name: 'small-phone', use: { ...devices['iPhone SE'], defaultBrowserType: 'chromium', channel: 'chrome' }, testMatch: /mobile\.spec/ },
    { name: 'landscape', use: { ...devices['Pixel 7 landscape'], channel: 'chrome' }, testMatch: /mobile\.spec/ },
    // Safari's engine. It needs system libraries (`npx playwright install --with-deps webkit`), so it is opt-in
    ...(process.env.E2E_WEBKIT ? [{ name: 'safari', use: { ...devices['iPhone 15'] }, testMatch: /mobile\.spec/ }] : []),
    // timing is only meaningful on a quiet machine, so these run one at a time (`fullyParallel: false` keeps the one spec file
    // in a single worker) after everything else has finished.
    // `npm run test:perf` passes --no-deps to run them alone
    { name: 'performance', fullyParallel: false, use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 1440, height: 900 } }, testMatch: /performance\.spec/, dependencies: ['desktop', 'responsive', 'android', 'iphone', 'small-phone', 'landscape'] },
  ],
  webServer: {
    // --strictPort: fail if the port is taken, since `baseURL` would point at whatever else is there
    command: PROD ? `npx vite build && npx vite preview --port ${PORT} --strictPort` : `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    // outside CI a server already on the port is used as it is: for a production run, that means it is not rebuilt
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
