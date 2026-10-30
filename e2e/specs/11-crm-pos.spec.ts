import { test, expect, loginFast, openModule, openTab } from '../support/fixtures'

/**
 * CRM (leads → pipeline → follow-ups → customer) and POS (counter billing).
 *
 * Both screens came out of the Mapsoft ERP feature comparison: the reference product sells
 * "SALES, POS, CRM" as one pillar, and the ERP only had the order-to-invoice half of it.
 */
test.describe('CRM', () => {
  test('the pipeline shows open leads with their value and next follow-up', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'CRM')

    await expect(page.getByText('Deccan Auto Systems').first()).toBeVisible()
    await expect(page.getByText('Kothrud Engineering').first()).toBeVisible()
    await expect(page.getByText('Rahul Deshmukh').first()).toBeVisible()

    // The card carries the value and the next thing to do.
    await expect(page.getByText('Send revised quotation for 500 nos').first()).toBeVisible()
    await expect(page.getByText('₹2,40,000.00').first()).toBeVisible()

    // Weighted forecast = Σ value × probability of the open leads.
    await expect(page.getByText('Weighted forecast')).toBeVisible()
  })

  test('a lead moves along the pipeline', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'CRM')

    // LD-0001 is Qualified; the board's advance button sends it to Proposal sent.
    await page.getByRole('button', { name: 'Advance LD-0001' }).click()
    await expect(page.getByText('Deccan Auto Systems → Proposal sent')).toBeVisible()

    const lead = (store.collections.leads as { code: string; stage: string; probability: number }[]).find((l) => l.code === 'LD-0001')
    expect(lead?.stage).toBe('PROPOSAL')
    expect(lead?.probability).toBe(60) // the stage sets the default probability
  })

  test('a new lead is created from the dialog', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'CRM')
    await page.getByRole('button', { name: 'New lead' }).click()

    const dialog = page.getByRole('dialog')
    await dialog.getByPlaceholder('Rahul Deshmukh').fill('Meera Joshi')
    await dialog.getByPlaceholder('Deccan Auto Systems').fill('Baner Machining')
    await dialog.getByRole('button', { name: 'Save' }).click()

    await expect(dialog).toBeHidden()
    const created = (store.collections.leads as { name: string; companyName?: string }[]).find((l) => l.name === 'Meera Joshi')
    expect(created?.companyName).toBe('Baner Machining')
    await expect(page.getByText('Baner Machining').first()).toBeVisible()
  })

  test('winning a lead creates the customer master', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'CRM')

    const before = (store.collections.customers as unknown[]).length
    await page.getByRole('button', { name: 'Convert LD-0002' }).click()
    await expect(page.getByText(/Customer created from Kothrud Engineering|Converted to customer/).first()).toBeVisible()

    const customers = store.collections.customers as { name: string }[]
    expect(customers.length).toBe(before + 1)
    expect(customers.some((c) => c.name === 'Kothrud Engineering')).toBe(true)

    const lead = (store.collections.leads as { code: string; stage: string; customerId?: string }[]).find((l) => l.code === 'LD-0002')
    expect(lead?.stage).toBe('WON')
    expect(lead?.customerId).toBeTruthy()
  })

  test('follow-ups are listed and can be ticked off', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'CRM')
    await openTab(page, 'Follow-ups')

    await expect(page.getByText('Send revised quotation for 500 nos')).toBeVisible()
    await page.getByRole('button', { name: 'Mark done' }).first().click()

    // The tab lists open follow-ups only, so the finished one drops out.
    await expect(page.getByText('Send revised quotation for 500 nos')).toBeHidden()
    const done = (store.collections['lead-activities'] as { summary: string; doneAt?: string | null }[])
      .find((a) => a.summary === 'Send revised quotation for 500 nos')
    expect(done?.doneAt).toBeTruthy()
  })
})

test.describe('POS', () => {
  test('a counter sale is billed and saved as a cash invoice', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'POS')

    await expect(page.getByText('Tap an item to start the bill')).toBeVisible()
    await page.getByRole('button', { name: 'Add EN8 Round Bar 40mm' }).click()
    await page.getByRole('button', { name: 'Add Ball Bearing 6204' }).click()

    // Two lines in the cart, priced off the item master (96 + 165, 18% GST).
    await expect(page.getByRole('button', { name: /^Charge/ })).toContainText('307.98')

    const before = (store.collections['sales-invoices'] as unknown[]).length
    await page.getByRole('button', { name: /^Charge/ }).click()

    await expect(page.getByText(/Sale .* saved/).first()).toBeVisible()
    const invoices = store.collections['sales-invoices'] as { isCashSale?: boolean; lines?: unknown[]; receivedMode?: string }[]
    expect(invoices.length).toBe(before + 1)
    const sale = invoices[0]
    expect(sale.isCashSale).toBe(true)
    expect(sale.receivedMode).toBe('CASH')
    expect(sale.lines?.length).toBe(2)

    // The cart is cleared and ready for the next customer.
    await expect(page.getByText('Tap an item to start the bill')).toBeVisible()
  })

  test('scanning adds the matching item to the cart', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'POS')

    const search = page.getByPlaceholder(/Scan barcode or search item/)
    await search.fill('FG-FLG')
    await search.press('Enter')

    await expect(page.getByLabel('Quantity FG-FLG — Flange Coupling FC-90')).toHaveValue('1')
    await expect(page.getByRole('button', { name: /^Charge/ })).toContainText('873.60')
  })
})
