import { readFile } from 'node:fs/promises'
import { test, expect, loginFast, openModule } from '../support/fixtures'
import type { Page } from '@playwright/test'

/** The row of a given invoice in the Sales Invoices table. */
function invoiceRow(page: Page, number: string) {
  return page.getByRole('row').filter({ hasText: number }).first()
}

/** Open the Tally / e-Invoice menu of one invoice row. */
async function openExportMenu(page: Page, number: string) {
  const row = invoiceRow(page, number)
  await expect(row).toBeVisible()
  await row.getByTitle('Tally / e-Invoice export').click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  // The menu is mounted (and its items laid out) before any item is clicked.
  await expect(menu.getByRole('menuitem').first()).toBeVisible()
  return menu
}

test.describe('Tally + e-Invoice export', () => {
  test('Tally XML download contains a Prime import envelope', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'Sales Invoices')

    const menu = await openExportMenu(page, 'INV/26-27/0001')
    const downloadPromise = page.waitForEvent('download')
    await menu.getByText('Tally XML (import file)').click()
    const download = await downloadPromise

    expect(download.suggestedFilename()).toBe('INV-26-27-0001_tally.xml')
    const path = await download.path()
    const xml = await readFile(path, 'utf8')
    expect(xml).toContain('<ENVELOPE>')
    expect(xml).toContain('<TALLYREQUEST>Import Data</TALLYREQUEST>')
    expect(xml).toContain('REMOTEID="MANUFLOW-INV-si_1"')
    expect(xml).toContain('<PARTYLEDGERNAME>Precision Tools Pvt Ltd</PARTYLEDGERNAME>')
    expect(xml).toContain('<VOUCHERNUMBER>INV/26-27/0001</VOUCHERNUMBER>')
  })

  test('a voucher can be pushed straight into Tally through the connector', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'Sales Invoices')

    // A different invoice than the mark/unmark test below, so the two do not share the flag.
    const menu = await openExportMenu(page, 'INV/26-27/0002')
    await menu.getByRole('menuitem', { name: 'Push to Tally (connector)' }).click()

    // The server queues the job, the (fake) connector settles it, the invoice is marked imported.
    await expect(page.getByText('Sending INV/26-27/0002 to Tally…')).toBeVisible()
    await expect(page.getByText('INV/26-27/0002 imported into TallyPrime')).toBeVisible({ timeout: 20_000 })

    const invoice = (store.collections['sales-invoices'] as { number: string; tallySentAt?: string | null }[])
      .find((i) => i.number === 'INV/26-27/0002')
    expect(invoice?.tallySentAt).toBeTruthy()
  })

  test('a purchase bill is pushed to Tally as a Purchase voucher', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'Purchase Invoices')

    const row = page.getByRole('row').filter({ hasText: 'BILL/26-27/0002' }).first()
    await expect(row).toBeVisible()
    await row.getByTitle('Push this bill to Tally (connector)').click()

    // The server queues a push-voucher job for the bill; the fake connector settles it.
    await expect(page.getByText('Sending bill BILL/26-27/0002 to Tally…')).toBeVisible()
    await expect(page.getByText('BILL/26-27/0002 imported into TallyPrime')).toBeVisible({ timeout: 20_000 })
  })

  test('Tally JSON download describes the same voucher', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'Sales Invoices')

    const menu = await openExportMenu(page, 'INV/26-27/0001')
    const downloadPromise = page.waitForEvent('download')
    await menu.getByText('Tally JSON').click()
    const download = await downloadPromise

    expect(download.suggestedFilename()).toBe('INV-26-27-0001_tally.json')
    const voucher = JSON.parse(await readFile(await download.path(), 'utf8'))
    expect(voucher.voucherType).toBe('Sales')
    expect(voucher.voucherNumber).toBe('INV/26-27/0001')
    expect(voucher.remoteId).toBe('MANUFLOW-INV-si_1')
    expect(voucher.party).toBe('Precision Tools Pvt Ltd')
    // Party is debited with the grand total; the tax ledgers balance it.
    const party = voucher.entries.find((e: { isParty: boolean }) => e.isParty)
    expect(party.amount).toBeCloseTo(29500, 2)
    expect(voucher.grandTotal).toBeCloseTo(29500, 2)
  })

  test('Tally Excel download is offered as a check-sheet', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'Sales Invoices')

    const menu = await openExportMenu(page, 'INV/26-27/0001')
    const downloadPromise = page.waitForEvent('download')
    await menu.getByText('Tally Excel').click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toBe('INV-26-27-0001_tally.xlsx')
  })

  test('an invoice can be marked as imported into Tally, and unmarked', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'Sales Invoices')

    let menu = await openExportMenu(page, 'INV/26-27/0001')
    await menu.getByRole('menuitem', { name: 'Mark as sent to Tally' }).click()
    await expect(page.locator('[data-sonner-toast]').first()).toBeVisible()

    // The mark is stored on the invoice row and the menu offers to clear it.
    menu = await openExportMenu(page, 'INV/26-27/0001')
    await expect(menu.getByText('Tally import · imported')).toBeVisible()
    await menu.getByRole('menuitem', { name: 'Clear "sent to Tally"' }).click()
    await expect(page.locator('[data-sonner-toast]').first()).toBeVisible()

    menu = await openExportMenu(page, 'INV/26-27/0001')
    await expect(menu.getByRole('menuitem', { name: 'Mark as sent to Tally' })).toBeVisible()
  })

  test('the Tally importer .bat and masters XML are downloadable', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'Sales Invoices')

    // The .bat ships as a static asset: drag an invoice XML onto it to post into Tally.
    const menu = await openExportMenu(page, 'INV/26-27/0001')
    const batPromise = page.waitForEvent('download')
    await menu.getByText('Tally importer (.bat)').click()
    const bat = await batPromise
    expect(bat.suggestedFilename()).toBe('Tally-Import.bat')
    const script = await readFile(await bat.path(), 'latin1')
    expect(script).toContain('ManuFlow ERP')
    expect(script).toContain('http://127.0.0.1:9000')
    expect(script).toContain('curl -s -m 30 -X POST')
    expect(script).toContain('<CREATED>')
    expect(script).toContain('TallyPrime acts as')

    // The masters file creates the ledgers the voucher names.
    const menu2 = await openExportMenu(page, 'INV/26-27/0001')
    const mastersPromise = page.waitForEvent('download')
    await menu2.getByText('Tally masters (XML)').click()
    const masters = await mastersPromise
    expect(masters.suggestedFilename()).toMatch(/^tally-masters-.*\.xml$/)
    const xml = await readFile(await masters.path(), 'utf8')
    expect(xml).toContain('<REPORTNAME>All Masters</REPORTNAME>')
    expect(xml).toContain('<LEDGER NAME="Sales">')
    await expect(page.getByText('Tally masters downloaded')).toBeVisible()

    // Same two entry points live in Settings → Tally export.
    await openModule(page, 'Settings')
    const tallyCard = page.locator('[data-slot="card"]').filter({ has: page.locator('[data-slot="card-title"]', { hasText: 'Tally export' }) })
    await expect(tallyCard.getByRole('link', { name: 'Tally importer (.bat)' })).toHaveAttribute('href', '/downloads/tally/Tally-Import.bat')
    await expect(tallyCard.getByRole('button', { name: 'Tally masters (XML)' })).toBeVisible()
  })

  test('e-Invoice JSON matches the NIC bulk-upload shape and opens the portal', async ({ page, store, context }) => {
    await loginFast(page, store)
    await openModule(page, 'Sales Invoices')

    // The portal tab the button opens is external; close it as soon as it appears.
    context.on('page', (p) => { if (p !== page) void p.close().catch(() => {}) })

    const menu = await openExportMenu(page, 'INV/26-27/0001')
    const downloadPromise = page.waitForEvent('download')
    await menu.getByText('e-Invoice JSON (GST portal)').click()
    const download = await downloadPromise

    expect(download.suggestedFilename()).toBe('INV-26-27-0001_einvoice.json')
    const payload = JSON.parse(await readFile(await download.path(), 'utf8'))
    expect(Array.isArray(payload)).toBe(true)
    expect(payload[0].Version).toBe('1.1')
    expect(payload[0].TranDtls.TaxSch).toBe('GST')
    expect(payload[0].TranDtls.SupTyp).toBe('B2B')
    expect(payload[0].DocDtls.No).toBe('INV/26-27/0001')
    expect(payload[0].BuyerDtls.Gstin).toBe('27AABCP1234C1ZU')
    expect(payload[0].ItemList.length).toBeGreaterThan(0)
    expect(payload[0].ValDtls.TotInvVal).toBeCloseTo(29500, 2)
  })
})
