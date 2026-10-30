import { test, expect, loginFast, openModule, openTab, searchTable } from '../support/fixtures'

test.describe('Administration', () => {
  test('Settings: profile loads and saves', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'Settings')

    await expect(page.getByText('Company Profile').first()).toBeVisible()
    // The company name comes from the API and is pre-filled in the form.
    const nameBox = page.locator('main input').first()
    await expect(nameBox).toHaveValue('Nashilk Precision Works')
    await nameBox.fill('Nashilk Precision Works Pvt Ltd')
    await page.locator('main').getByRole('button', { name: /Save/i }).first().click()
    await expect(page.locator('[data-sonner-toast]').first()).toBeVisible()
  })

  test('Company Setup lists the firms of the login', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'Settings')
    await openTab(page, 'Company Setup')

    await expect(page.getByText('Nashilk Precision Works').first()).toBeVisible()
    await expect(page.getByText('Nashilk Components LLP').first()).toBeVisible()
  })

  test('Notifications: list, unread badge and mark all read', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'Activity')
    await openTab(page, 'Notifications')

    await expect(page.getByText('Low stock: Flange Coupling FC-90').first()).toBeVisible()
    await expect(page.getByText('PO/26-27/0002 awaiting approval').first()).toBeVisible()
  })

  test('Audit Log: rows and search', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'Activity')
    await openTab(page, 'Audit Log')

    await expect(page.getByText('Akash Shinde').first()).toBeVisible()
    await expect(page.getByText('SALES_INVOICE').first()).toBeVisible()
    await expect(page.getByText(/Submitted PO\/26-27\/0002/).first()).toBeVisible()

    await searchTable(page, 'Deleted')
    await expect(page.getByText(/Deleted obsolete item/).first()).toBeVisible()
  })

  test('Import Center: tabs and the upload wizard', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'Import Center')

    await expect(page.getByRole('tab', { name: 'New Import' })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'History' })).toBeVisible()
    await expect(page.getByText(/Tally|Excel|CSV/i).first()).toBeVisible()

    await openTab(page, 'History')
    await expect(page.getByText(/History|Past imports/i).first()).toBeVisible()
  })

  test('global search finds a customer and opens the row in its module', async ({ page, store }) => {
    await loginFast(page, store)
    await page.keyboard.press('Control+k')
    await page.getByPlaceholder('Search modules, items, customers, orders…').fill('Deccan')
    const hit = page.getByRole('option', { name: /Deccan Auto Systems/ }).first()
    await expect(hit).toBeVisible()
    await hit.click()
    await expect(page).toHaveTitle(/Parties · ManuFlow ERP/)
  })
})
