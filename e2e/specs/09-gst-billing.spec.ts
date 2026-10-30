import { test, expect, loginFast, openModule, openCreate } from '../support/fixtures'

test.describe('GST billing options', () => {
  test('invoice dialog exposes document type, currency and reverse charge', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'Sales Invoices')
    const dialog = await openCreate(page, 'Invoice')

    // Native selects: [0] document type, [1] currency.
    const docType = dialog.locator('select').nth(0)
    const currency = dialog.locator('select').nth(1)

    await expect(docType).toHaveValue('TAX_INVOICE')
    await expect(currency).toHaveValue('INR')
    await expect(dialog.getByText('Reverse charge (Sec 9(3)/9(4))')).toBeVisible()

    // Foreign currency reveals the exchange-rate field instead of the fixed 1.00.
    await currency.selectOption('USD')
    await expect(dialog.getByText('Exchange rate (1 USD = ₹)')).toBeVisible()
    await expect(dialog.locator('input[type="number"]').first()).toHaveValue('83')

    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
  })

  test('bill of supply and proforma are offered as invoice types', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'Sales Invoices')
    const dialog = await openCreate(page, 'Invoice')
    const docType = dialog.locator('select').nth(0)

    await expect(docType.locator('option')).toHaveText([
      'Tax Invoice',
      'Bill of Supply (exempt)',
      'Proforma Invoice',
    ])

    await docType.selectOption('BILL_OF_SUPPLY')
    await expect(docType).toHaveValue('BILL_OF_SUPPLY')

    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
  })

  test('the line editor suggests the GST rate from the item HSN', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'Sales Invoices')
    const dialog = await openCreate(page, 'Invoice')

    // "Flange Coupling FC-90" is billed at 12% but HSN 8483 is an 18% code.
    await dialog.getByPlaceholder('Search or add item…').first().click()
    await dialog.getByRole('button', { name: /FG-FLG/ }).click()

    const gstField = dialog.getByPlaceholder('GST %').first()
    await expect(gstField).toHaveValue('12')

    const hint = dialog.getByRole('button', { name: 'HSN 8483 → 18%' })
    await expect(hint).toBeVisible()
    await hint.click()
    await expect(gstField).toHaveValue('18')

    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
  })
})
