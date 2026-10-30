import { test, expect, loginFast, openModule, openTab } from '../support/fixtures'

test.describe('Inventory', () => {
  test('Stock: balance and ledger tabs', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'Stock')

    // Stock Balance is the default tab and renders the balance table.
    await expect(page.getByRole('columnheader', { name: 'Item' }).first()).toBeVisible()
    await openTab(page, 'Stock Ledger')
    await expect(page.getByText('EN8 Round Bar 40mm').first()).toBeVisible()
    await expect(page.getByText('PRODUCTION').first()).toBeVisible()
  })

  test('Transfers & Adjustments: both documents render', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'Transfers & Adjustments')
    await expect(page.getByText('Recent transfers (1)')).toBeVisible()
    await expect(page.getByText(/FG-FLG/).first()).toBeVisible()

    await openTab(page, 'Adjustments')
    await expect(page.locator('tbody').getByText(/Ball Bearing 6204/).first()).toBeVisible()
    await expect(page.locator('tbody').getByText('DAMAGE').first()).toBeVisible()
  })
})

test.describe('Manufacturing', () => {
  test('Production: work orders, material issues and entries', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'Production')

    await expect(page.getByText('WO/26-27/0001')).toBeVisible()
    await expect(page.getByText('Shaft Assembly SF-220').first()).toBeVisible()

    await openTab(page, 'Material Issues')
    await expect(page.getByText('MI/26-27/0001')).toBeVisible()

    await openTab(page, 'Production Entries')
    await expect(page.getByRole('columnheader', { name: /Produced/ })).toBeVisible()
  })

  test('MRP shows shortages and reorder suggestions', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'MRP')
    await expect(page.getByText(/Material Requirements|MRP/i).first()).toBeVisible()
    await expect(page.locator('main')).toContainText(/short|reorder|Required/i)
  })

  test('QC Inspections list inspections with result chips', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'QC Inspections')
    await expect(page.getByText('QC/26-27/0001')).toBeVisible()
    await expect(page.getByText('PASSED').first()).toBeVisible()
    await expect(page.getByText('FINAL').first()).toBeVisible()
  })
})
