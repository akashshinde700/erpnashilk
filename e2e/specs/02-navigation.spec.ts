import { test, expect, loginFast, openModule, openModuleFromSidebar, openTab } from '../support/fixtures'
import type { Locator, Page } from '@playwright/test'

/** A screen counts as painted when the module area has real content and no error toast. */
async function expectModulePainted(page: Page, main: Locator) {
  await expect.poll(async () => (await main.innerText()).trim().length, { timeout: 15_000 }).toBeGreaterThan(20)
  await expect(page.locator('[data-sonner-toast]', { hasText: 'Could not load data' })).toHaveCount(0)
}
import { SCREENS, MODULE_GROUPS } from '../support/modules'

test.describe('Application shell & navigation', () => {
  test('boots to the dashboard with the full sidebar', async ({ page, store }) => {
    await loginFast(page, store)
    await expect(page).toHaveTitle(/Dashboard · ManuFlow ERP/)

    const nav = page.getByRole('navigation', { name: 'ERP modules' })
    await expect(nav).toBeVisible()
    // Every group is listed in the rail, in registry order.
    for (const group of MODULE_GROUPS) {
      await expect(nav.getByRole('button', { name: new RegExp(`^${group}`) }).first()).toBeVisible()
    }
    // Dashboard is always expanded and marks itself as the current page.
    await expect(nav.getByRole('button', { name: 'Dashboard', exact: true })).toHaveAttribute('aria-current', 'page')
  })

  test('sidebar expands a group and switches modules', async ({ page, store }) => {
    await loginFast(page, store)
    await openModuleFromSidebar(page, 'Masters', 'Items')
    await expect(page).toHaveTitle(/Items · ManuFlow ERP/)
    const nav = page.getByRole('navigation', { name: 'ERP modules' })
    await expect(nav.getByRole('button', { name: 'Items', exact: true })).toHaveAttribute('aria-current', 'page')

    await openModuleFromSidebar(page, 'Finance', 'Cash & Bank')
    await expect(page).toHaveTitle(/Cash & Bank · ManuFlow ERP/)
  })

  test('command palette jumps to any module and searches records', async ({ page, store }) => {
    await loginFast(page, store)
    await page.keyboard.press('Control+k')
    const input = page.getByPlaceholder('Search modules, items, customers, orders…')
    await expect(input).toBeVisible()

    await input.fill('GST')
    await expect(page.locator('[role="option"][data-value="module-GST Reports"]')).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page).toHaveTitle(/GST Reports · ManuFlow ERP/)

    // Record search hits /api/search and lists the matches.
    await page.keyboard.press('Control+k')
    await page.getByPlaceholder('Search modules, items, customers, orders…').fill('Precision')
    await expect(page.getByRole('option', { name: /Precision Tools Pvt Ltd/ }).first()).toBeVisible()
  })

  test('theme toggle switches between light and dark', async ({ page, store }) => {
    await loginFast(page, store)
    const html = page.locator('html')
    const before = await html.getAttribute('class')
    await page.getByRole('button', { name: /Switch to (dark|light) mode/ }).click()
    await expect
      .poll(async () => ((await html.getAttribute('class')) || '').includes('dark'))
      .not.toBe(((before || '').includes('dark')))
  })

  test('notifications popover lists unread items and marks them read', async ({ page, store }) => {
    await loginFast(page, store)
    await page.getByRole('button', { name: /^Notifications \(\d+ unread\)$/ }).click()
    await expect(page.getByText('Low stock: Flange Coupling FC-90').first()).toBeVisible()
    await expect(page.getByText('PO/26-27/0002 awaiting approval').first()).toBeVisible()
    await page.getByRole('button', { name: /Mark all read/ }).click()
    await expect(page.getByRole('button', { name: /^Notifications \(0 unread\)$/ })).toBeVisible()
  })

  test('keyboard shortcut dialog opens and closes', async ({ page, store }) => {
    await loginFast(page, store)
    await page.keyboard.press('Shift+?')
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Keyboard').first()).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  })

  test('sidebar can be collapsed and remembers the choice', async ({ page, store }) => {
    await loginFast(page, store)
    await page.getByRole('button', { name: 'Collapse sidebar' }).click()
    await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible()
    await page.getByRole('button', { name: 'Expand sidebar' }).click()
    await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible()
  })

  test('mobile viewport opens the navigation drawer', async ({ page, store }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await loginFast(page, store)
    await expect(page.getByRole('navigation', { name: 'ERP modules' })).toBeHidden()
    await page.getByRole('button', { name: 'Open navigation' }).click()
    const nav = page.getByRole('navigation', { name: 'ERP modules' })
    await expect(nav).toBeVisible()
    await nav.getByRole('button', { name: 'Dashboard', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible()
  })
})

test.describe('Every screen renders', () => {
  for (const screen of SCREENS) {
    test(`${screen.group} › ${screen.label}`, async ({ page, store, pageErrors }) => {
      await loginFast(page, store)
      await openModule(page, screen.label)

      const main = page.locator('main')
      await expect(main).toBeVisible()
      await expectModulePainted(page, main)

      // Tab groups: every hosted screen must paint too.
      for (const tab of screen.tabs ?? []) {
        await openTab(page, tab.label)
        await expect.poll(async () => (await main.innerText()).trim().length, { timeout: 15_000 }).toBeGreaterThan(20)
      }

      // A failed list load surfaces as a toast — that would be a broken screen, not an empty one.
      await expect(page.locator('[data-sonner-toast]', { hasText: 'Could not load data' })).toHaveCount(0)

      expect(pageErrors, `page errors on ${screen.label}`).toEqual([])
    })
  }
})
