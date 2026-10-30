import { test, expect, loginFast, openModule, openCreate } from '../support/fixtures'

test.describe('Purchase cycle', () => {
  test('Requisitions list requests with their status', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'Requisitions')
    await expect(page.getByText('PR/26-27/0001')).toBeVisible()
    await expect(page.getByText('PR/26-27/0002')).toBeVisible()
  })

  test('Purchase Orders list orders and their approval state', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'Purchase Orders')
    await expect(page.getByText('PO/26-27/0001')).toBeVisible()
    await expect(page.getByText('Gujarat Bearings Co').first()).toBeVisible()
  })

  test('GRN lists goods receipts against orders', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'GRN')
    await expect(page.getByText('GRN/26-27/0001')).toBeVisible()
    await expect(page.getByText('GRN/26-27/0002')).toBeVisible()
  })

  test('Purchase Invoices list bills with supplier bill numbers', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'Purchase Invoices')
    await expect(page.getByText('BILL/26-27/0001')).toBeVisible()
    await expect(page.getByText('Bharat Steel Depot').first()).toBeVisible()
  })

  test('Purchase Returns (debit notes) are listed', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'Purchase Returns')
    await expect(page.getByText('DN/26-27/0001')).toBeVisible()
  })

  test('a purchase bill can be started from the dialog', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'Purchase Invoices')
    const dialog = await openCreate(page, /^Invoice$/)
    await expect(dialog.getByRole('button', { name: /Create|Save/ }).first()).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
  })
})
