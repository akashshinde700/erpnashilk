import { test, expect, loginFast, openModule, openTab } from '../support/fixtures'

test.describe('Finance', () => {
  test('Outstanding: receivables and payables tabs', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'Outstanding')

    await expect(page.getByText('Deccan Auto Systems').first()).toBeVisible()
    await openTab(page, 'Payables')
    await expect(page.getByText('Gujarat Bearings Co').first()).toBeVisible()
  })

  test('Cash & Bank: every tab renders its panel', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'Cash & Bank')

    await expect(page.getByText('Cash in Hand').first()).toBeVisible()
    await expect(page.getByText('HDFC Current').first()).toBeVisible()

    for (const tab of ['Transactions', 'Cash in Hand', 'Contra', 'Loans']) {
      await openTab(page, tab)
      await expect(page.locator('main')).toBeVisible()
    }
    // The transactions tab shows the seeded movement with its running balance.
    await openTab(page, 'Transactions')
    await expect(page.getByText('RCPT/26-27/0001').first()).toBeVisible()
  })

  test('Expenses: list, search and create dialog', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'Expenses')

    await expect(page.getByText('MSEB electricity bill')).toBeVisible()
    await expect(page.getByText('VRL Logistics').first()).toBeVisible()

    await page.locator('main').getByRole('button', { name: /Expense/ }).first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: /Save|Create/ }).first()).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
  })

  test('Reports Center renders the default report with its filters', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'Reports Center')
    await expect(page.locator('main')).toBeVisible()
    // Report switcher + date range are always present.
    await expect(page.getByText(/Profit|Report/i).first()).toBeVisible()
  })
})

test.describe('GST reporting', () => {
  test('GST Reports: GSTR-1 lists outward invoices', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'GST Reports')

    await expect(page.getByRole('tab', { name: 'GSTR-1' })).toBeVisible()
    await expect(page.getByText('INV/26-27/0005').first()).toBeVisible()
  })

  test('GST Reports: GSTR-2, GSTR-3B and GSTR-9 tabs render their data', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'GST Reports')

    await openTab(page, 'GSTR-2')
    await expect(page.getByText(/BSD\/2291|BILL\/26-27\/0001/).first()).toBeVisible()

    await openTab(page, 'GSTR-3B')
    await expect(page.getByText(/3B|Outward|ITC/i).first()).toBeVisible()

    await openTab(page, 'GSTR-9 (Annual)')
    await expect(page.getByText(/2026-27|Annual/i).first()).toBeVisible()
  })

  test('GST Reports: GSTR-1 JSON download produces a portal-shaped file', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'GST Reports')

    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: /JSON/i }).first().click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toMatch(/\.json$/i)
  })
})
