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

test.describe('QC inspection records', () => {
  test('a completed inspection opens read only', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'QC Inspections')
    await page.getByText('QC/26-27/0002').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('QC Details — QC/26-27/0002')).toBeVisible()
    await expect(dialog.getByText('Read only')).toBeVisible()
    await expect(dialog.getByText('GRN/26-27/0001')).toBeVisible()
    for (const label of ['Checked', 'Accepted', 'Rejected', 'Inspector']) await expect(dialog.getByText(label, { exact: true })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Submit Result' })).toHaveCount(0)
    await expect(dialog.getByRole('textbox')).toHaveCount(0)
  })

  test('a pending inspection opens the result form, which shows unaccounted qty', async ({ page, store }) => {
    const done = store.collections['qc-inspections'][1] as Record<string, unknown>
    store.collections['qc-inspections'].push({ ...done, id: 'qc_open', number: 'QC/26-27/0099', status: 'PENDING', qtyAccepted: 0, qtyRejected: 0, inspector: 'pending' })
    await loginFast(page, store)
    await openModule(page, 'QC Inspections')
    await page.getByText('QC/26-27/0099').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Submit Result — QC/26-27/0099')).toBeVisible()
    await dialog.locator('input').first().fill('1')
    await expect(dialog.getByText(/399 unaccounted for/)).toBeVisible()
    await dialog.getByRole('button', { name: 'Submit Result' }).click()
    await expect(page.getByText(/must equal the checked qty/).first()).toBeVisible()
    await expect(dialog).toBeVisible()
  })
})
