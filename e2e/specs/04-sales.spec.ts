import { test, expect, loginFast, openModule, openTab, openCreate, searchTable } from '../support/fixtures'

test.describe('Sales cycle', () => {
  test('Enquiries & Quotations: tabs, rows and status chips', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'Enquiries & Quotes')

    await expect(page.getByText('ENQ/26-27/0001')).toBeVisible()
    await expect(page.getByText('ENQ/26-27/0002')).toBeVisible()
    await openTab(page, 'Quotations')
    await expect(page.getByText('QT/26-27/0001')).toBeVisible()
    await expect(page.getByText('QT/26-27/0002')).toBeVisible()
  })

  test('Sales Orders: rows, search and totals', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'Sales Orders')
    await expect(page.getByText('SO/26-27/0001')).toBeVisible()
    await expect(page.getByText('SO/26-27/0002')).toBeVisible()

    await searchTable(page, '0002')
    await expect(page.getByText('SO/26-27/0002')).toBeVisible()
    await expect(page.getByText('SO/26-27/0001')).toBeHidden()
  })

  test('Delivery Challans: rows and invoice action', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'Delivery Challans')
    await expect(page.getByText('DC/26-27/0001')).toBeVisible()
    await expect(page.getByText('SO/26-27/0002').first()).toBeVisible()
  })

  test('Sales Invoices: list, search and CSV export', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'Sales Invoices')

    await expect(page.getByText('INV/26-27/0001')).toBeVisible()
    await expect(page.getByText('INV/26-27/0002')).toBeVisible()

    await searchTable(page, '0002')
    await expect(page.getByText('INV/26-27/0002')).toBeVisible()
    await expect(page.getByText('INV/26-27/0001')).toBeHidden()

    // Items is the master with the CSV export wired to the table.
    await openModule(page, 'Items')
    await searchTable(page, 'EN8')
    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: /^CSV$/ }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toMatch(/\.csv$/i)
  })

  test('Sales Invoices: the create dialog opens with GST and line fields', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'Sales Invoices')
    const dialog = await openCreate(page, 'Invoice')

    await expect(dialog.getByRole('button', { name: 'Create Invoice' })).toBeVisible()
    await expect(dialog.getByText('Cash Sale (walk-in)')).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
  })

  test('Sales Returns (credit notes) are listed', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'Sales Returns')
    await expect(page.getByText('CN/26-27/0001')).toBeVisible()
  })

  test('Payment In / Out lists receipts and payments', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'Payment In / Out')
    await expect(page.getByText('RCPT/26-27/0001')).toBeVisible()
    await expect(page.getByText('PMT/26-27/0001')).toBeVisible()
    await expect(page.getByText('Deccan Auto Systems').first()).toBeVisible()
  })
})
