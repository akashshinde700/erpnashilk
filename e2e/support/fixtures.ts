import { test as base, expect, type Page } from '@playwright/test'
import { createStore, ADMIN_EMAIL, ADMIN_PASSWORD, type Store } from './store'
import { installMockApi, seedSession, type MockApi } from './mock-api'

/** Console noise that the sandbox/dev server produces and that no test should fail on. */
const IGNORED_CONSOLE = [
  /Download the React DevTools/i,
  /\[Fast Refresh\]/i,
  /Failed to load resource: the server responded with a status of 401/i, // expected on the login screen
  /socket\.io|websocket/i,
  /net::ERR_ABORTED/i,
  /Warning: Extra attributes from the server/i,
]

export interface AppFixtures {
  store: Store
  api: MockApi
  /** Page with the fake API installed and browser errors collected. */
  consoleErrors: string[]
  pageErrors: string[]
}

export const test = base.extend<AppFixtures>({
  store: async ({}, use) => {
    // Playwright's fixture `use()` — not a React hook (the react-hooks rule sees the name and guesses).
    // eslint-disable-next-line react-hooks/rules-of-hooks
    await use(createStore())
  },

  api: [
    async ({ page, store }, use) => {
      const api = await installMockApi(page, store)
      await use(api)
    },
    { auto: true },
  ],

  consoleErrors: [
    async ({ page }, use) => {
    const errors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return
      const text = msg.text()
      if (IGNORED_CONSOLE.some((re) => re.test(text))) return
      errors.push(text)
    })
    await use(errors)
    },
    { auto: true },
  ],

  pageErrors: [
    async ({ page }, use) => {
      const errors: string[] = []
      page.on('pageerror', (err) => {
        errors.push(err.message)
      })
      await use(errors)
    },
    { auto: true },
  ],
})

export { expect }

/** Sign in through the real login form. */
export async function login(page: Page, email = ADMIN_EMAIL, password = ADMIN_PASSWORD) {
  await page.goto('/')
  await page.locator('#login-email').fill(email)
  await page.locator('#login-password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('navigation', { name: 'ERP modules' })).toBeVisible()
}

/** Start already signed in (skips the form, keeps the real /api/auth/me boot path). */
export async function loginFast(page: Page, store: Store) {
  await seedSession(page, store)
  await page.goto('/')
  // The rail is hidden on small screens — the drawer button proves the shell is up there.
  await expect(
    page.getByRole('navigation', { name: 'ERP modules' })
      .or(page.getByRole('button', { name: 'Open navigation' })),
  ).toBeVisible()
}

/** Wait for the app shell after a navigation. */
export async function waitForShell(page: Page) {
  await expect(page.getByRole('navigation', { name: 'ERP modules' })).toBeVisible()
}

/**
 * Jump to a sidebar entry with the command palette (Ctrl+K → type the label → Enter).
 * Works for every module regardless of sidebar accordion state.
 */
export async function openModule(page: Page, label: string) {
  await page.keyboard.press('Control+k')
  const input = page.getByPlaceholder('Search modules, items, customers, orders…')
  await expect(input).toBeVisible()
  await input.fill(label)
  // cmdk sets data-value="module-<label>"; the accessible name is "<label> <group>".
  const option = page.locator(`[role="option"][data-value="module-${label.replace(/"/g, '&quot;')}"]`).first()
  await expect(option).toBeVisible()
  try {
    await option.click({ timeout: 5000 })
  } catch {
    // cmdk keeps the option highlighted; Enter is a resilient fallback when an
    // overlay swallows the pointer event mid-animation.
    await page.keyboard.press('Enter')
  }
  await expect(page).toHaveTitle(new RegExp(`${escapeRe(label)} · ManuFlow ERP`))
}

/** Open a tab inside a tab-group module (Parties → Suppliers, Production → Work Orders, …). */
export async function openTab(page: Page, label: string) {
  await page.getByRole('tab', { name: label, exact: true }).click()
  await expect(page.getByRole('tab', { name: label, exact: true })).toHaveAttribute('data-state', 'active')
}

/** Jump to a module by clicking the sidebar (expands the group when it is collapsed). */
export async function openModuleFromSidebar(page: Page, group: string, label: string) {
  const nav = page.getByRole('navigation', { name: 'ERP modules' })
  const groupButton = nav.getByRole('button', { name: new RegExp(`^${escapeRe(group)}`) }).first()
  if ((await groupButton.getAttribute('aria-expanded')) !== 'true') await groupButton.click()
  await nav.getByRole('button', { name: label, exact: true }).click()
  await expect(page).toHaveTitle(new RegExp(`${escapeRe(label)} · ManuFlow ERP`))
}

export function escapeRe(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Open the "new record" dialog from a module header (e.g. "Customer", "Item", "Invoice"). */
export async function openCreate(page: Page, buttonName: string | RegExp) {
  await page.locator('main').getByRole('button', { name: buttonName }).first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  return dialog
}

/** Type into the module's table search box and wait for the filter to apply. */
export async function searchTable(page: Page, text: string) {
  const box = page.locator('main').getByPlaceholder(/^Search/).first()
  await box.fill(text)
  return box
}
