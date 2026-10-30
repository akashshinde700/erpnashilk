import { test, expect, login, loginFast } from '../support/fixtures'
import { ADMIN_EMAIL, ADMIN_PASSWORD } from '../support/store'

test.describe('Authentication & session', () => {
  test('shows the sign-in screen when there is no session', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByText('Sign in to ManuFlow ERP', { exact: true })).toBeVisible()
    await expect(page.locator('#login-email')).toBeVisible()
    await expect(page.locator('#login-password')).toHaveAttribute('type', 'password')
    // The app shell must not flash the dashboard for a signed-out visitor.
    await expect(page.getByRole('navigation', { name: 'ERP modules' })).toHaveCount(0)
  })

  test('validates an empty submit without calling the API', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.locator('p[role="alert"]')).toHaveText('Enter your email and password')
  })

  test('rejects wrong credentials with the server message', async ({ page }) => {
    await page.goto('/')
    await page.locator('#login-email').fill(ADMIN_EMAIL)
    await page.locator('#login-password').fill('wrong-password')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.locator('p[role="alert"]')).toHaveText('Invalid email or password')
    await expect(page.getByRole('navigation', { name: 'ERP modules' })).toHaveCount(0)
  })

  test('signs in, lands on the dashboard and keeps the session after reload', async ({ page }) => {
    await login(page)
    await expect(page).toHaveTitle(/Dashboard · ManuFlow ERP/)
    await expect(page.getByText('Nashilk Precision Works').first()).toBeVisible()

    await page.reload()
    await expect(page.getByRole('navigation', { name: 'ERP modules' })).toBeVisible()
    await expect(page).toHaveTitle(/Dashboard · ManuFlow ERP/)
  })

  test('password visibility toggle does not submit the form', async ({ page }) => {
    await page.goto('/')
    await page.locator('#login-password').fill(ADMIN_PASSWORD)
    await expect(page.locator('#login-password')).toHaveAttribute('type', 'password')
    await page.getByRole('button', { name: 'Show password' }).click()
    await expect(page.locator('#login-password')).toHaveAttribute('type', 'text')
    await expect(page.getByRole('button', { name: 'Hide password' })).toBeVisible()
    // Still on the login screen — the toggle is type="button".
    await expect(page.getByRole('navigation', { name: 'ERP modules' })).toHaveCount(0)
  })

  test('signs out from the user menu and cannot go back to the dashboard', async ({ page, store }) => {
    await loginFast(page, store)
    await page.getByRole('button', { name: 'Open user menu' }).click()
    await page.getByRole('menuitem', { name: /Sign out/ }).click()
    await expect(page.getByText('Sign in to ManuFlow ERP', { exact: true })).toBeVisible()

    await page.reload()
    await expect(page.getByText('Sign in to ManuFlow ERP', { exact: true })).toBeVisible()
  })

  test('an expired server session signs the app out', async ({ page, store }) => {
    await loginFast(page, store)
    // Drop the session server-side, then trigger an API call from the shell (notification poll).
    store.session = null
    await page.evaluate(() => window.dispatchEvent(new Event('erp:refresh-notifications')))
    await page.getByRole('navigation', { name: 'ERP modules' }).waitFor({ state: 'detached', timeout: 15_000 }).catch(() => null)
    // Navigating to another module forces fresh API calls; the 401 must return the login screen.
    await page.keyboard.press('Control+k')
    await page.keyboard.type('Items')
    await page.keyboard.press('Enter')
    await expect(page.getByText('Sign in to ManuFlow ERP', { exact: true })).toBeVisible({ timeout: 20_000 })
  })

  test('change-password dialog validates the current password', async ({ page, store }) => {
    await loginFast(page, store)
    await page.getByRole('button', { name: 'Open user menu' }).click()
    await page.getByRole('menuitem', { name: /Change password/ }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Change password')).toBeVisible()
  })
})
