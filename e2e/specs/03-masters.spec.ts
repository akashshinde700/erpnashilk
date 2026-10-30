import { test, expect, loginFast, openModule, openTab, openCreate, searchTable } from '../support/fixtures'

test.describe('Masters', () => {
  test('Items: table, search and create dialog', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'Items')

    // Seed rows are on screen.
    await expect(page.getByText('EN8 Round Bar 40mm')).toBeVisible()
    await expect(page.getByText('Ball Bearing 6204')).toBeVisible()

    // The table search filters rows down.
    await searchTable(page, 'Bearing')
    await expect(page.getByText('Ball Bearing 6204')).toBeVisible()
    await expect(page.getByText('EN8 Round Bar 40mm')).toBeHidden()

    // The create dialog carries the GST fields an item needs.
    const dialog = await openCreate(page, 'Item')
    await expect(dialog.getByPlaceholder('Hex Bolt M8')).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Create' })).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
  })

  test('Items: a new item is created through the dialog', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'Items')
    const dialog = await openCreate(page, 'Item')

    await dialog.getByPlaceholder('Hex Bolt M8').fill('Test Pulley 90mm')
    await dialog.getByPlaceholder('Auto (RM-001…)').fill('RM-PUL')
    await dialog.getByRole('button', { name: 'Create' }).click()

    await expect(dialog).toBeHidden()
    await expect(page.getByText('Test Pulley 90mm')).toBeVisible()
    const created = (store.collections.items as { name: string }[]).find((i) => i.name === 'Test Pulley 90mm')
    expect(created).toBeTruthy()
  })

  test('Parties: customers tab lists, creates and switches to suppliers', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'Parties')

    // Customers tab is the default and lists customers with their GSTIN.
    await expect(page.getByText('Precision Tools Pvt Ltd')).toBeVisible()
    await expect(page.getByText('27AABCP1234C1ZU').first()).toBeVisible()

    const dialog = await openCreate(page, 'Customer')
    await dialog.getByPlaceholder('Precision Tools Pvt Ltd').fill('E2E Traders')
    // The Tally ledger name is what the Tally export / masters file posts this party to.
    await dialog.getByLabel('Tally ledger name').fill('E2E TRADERS')
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByText('E2E Traders')).toBeVisible()

    const saved = (store.collections.customers as { name: string; tallyLedgerName?: string }[]).find((c) => c.name === 'E2E Traders')
    expect(saved?.tallyLedgerName).toBe('E2E TRADERS')

    await openTab(page, 'Suppliers')
    await expect(page.getByText('Bharat Steel Depot')).toBeVisible()
    await expect(page.getByText('Gujarat Bearings Co')).toBeVisible()
  })

  test('Warehouses and Machines list their masters', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'Warehouses')
    await expect(page.getByText('MAIN').first()).toBeVisible()

    await openModule(page, 'Machines')
    await expect(page.getByText('CNC-01').first()).toBeVisible()
    await expect(page.getByText('GRD-03').first()).toBeVisible()
  })

  test('BOM shows the components of a bill of materials', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'BOM')
    await expect(page.getByText('BOM-SF220')).toBeVisible()
  })

  test('Users & Roles lists users with their status', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'Users & Roles')
    await expect(page.getByText('Akash Shinde').first()).toBeVisible()
    await expect(page.getByText('Rohit Kulkarni').first()).toBeVisible()
    await expect(page.getByText('store@nashilk.test').first()).toBeVisible()
  })
})
