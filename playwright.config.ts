import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright end-to-end configuration for ManuFlow ERP.
 *
 * Two supported ways to run the suite:
 *
 *  1. `npm run test:e2e`          — UI suite against the app with the in-browser fake API
 *                                   (e2e/support/mock-api.ts). Needs no database, so it runs
 *                                   anywhere the Next.js server can boot.
 *  2. a "live" mode against real route handlers + MySQL is **not implemented** — every
 *                                   spec installs the in-browser API double (e2e/support/fixtures.ts
 *                                   auto-fixture). Setting E2E_LIVE_API / E2E_MODE=live therefore
 *                                   fails loudly instead of quietly passing against the fake API.
 *                                   API-level, real-database coverage lives in tests/ (bun test).
 *
 * `PLAYWRIGHT_CHROMIUM_EXECUTABLE` lets a sandbox point at a Chromium binary it already has
 * instead of downloading one through `npx playwright install`.
 */
// A flag that does nothing is worse than no flag: someone runs `E2E_LIVE_API=1 playwright test`, sees
// green, and believes the suite exercised MySQL. It never did — the mock API is installed by an
// auto-fixture in e2e/support/fixtures.ts for every spec. Real-database coverage is `bun test` in
// tests/ (route handlers + Prisma), so point people there instead of pretending.
if (process.env.E2E_LIVE_API || process.env.E2E_MODE === 'live') {
  throw new Error(
    'Live E2E mode (E2E_LIVE_API / E2E_MODE=live) is not implemented: every spec uses the in-browser mock API.\n'
    + 'Real-database coverage: `bun test` (tests/, needs TEST_DATABASE_URL) and the manual checklist in docs/LOCAL-TEST-PROMPT.md.',
  )
}

const PORT = Number(process.env.E2E_PORT || 3000)
const baseURL = process.env.E2E_BASE_URL || `http://127.0.0.1:${PORT}`

export default defineConfig({
  outputDir: './test-results/artifacts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 1,
  reporter: process.env.CI
    ? [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }], ['github']]
    : [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }], ['json', { outputFile: 'test-results/results.json' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 20_000,
    navigationTimeout: 60_000,
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {},
  },
  projects: [
    {
      name: 'chromium',
      testDir: './e2e/specs',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      // Pure-function tests (Tally voucher / e-Invoice JSON builders) — no browser,
      // no API, no database. They run in the same invocation as the UI suite.
      name: 'unit',
      testDir: './e2e/unit',
      use: {},
    },
  ],
  webServer: process.env.E2E_SKIP_WEBSERVER
    ? undefined
    : {
        command: process.env.E2E_WEB_COMMAND || 'npm run dev',
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 240_000,
        stdout: 'pipe',
        stderr: 'pipe',
      },
})
