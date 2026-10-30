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
  await expect(page.getByRole('menu')).toBeVisible()
  return page.getByRole('menu')
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
    await menu.getByText('Mark as sent to Tally').click()
    await expect(page.locator('[data-sonner-toast]').first()).toBeVisible()

    // The mark is stored on the invoice row and the menu offers to clear it.
    menu = await openExportMenu(page, 'INV/26-27/0001')
    await expect(menu.getByText('Tally import · imported')).toBeVisible()
    await menu.getByText('Clear "sent to Tally"').click()
    await expect(page.locator('[data-sonner-toast]').first()).toBeVisible()

    menu = await openExportMenu(page, 'INV/26-27/0001')
    await expect(menu.getByText('Mark as sent to Tally')).toBeVisible()
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
