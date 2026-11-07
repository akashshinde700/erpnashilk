import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { test, expect, loginFast, openModule } from '../support/fixtures'
import type { Page, Route } from '@playwright/test'
import type { Store } from '../support/store'

// Import from Excel / CSV (import-wizard.tsx). The file step: which files are offered, which are refused at once, and
// what is explained. The full XML workflow: the wizard against stored responses of the real parse / preview / commit
// routes for a made-up Tally master file (e2e/fixtures; tests/import-e2e-contract.test.ts checks they are still exactly
// what the routes return). Every format against the real routes and database: tests/import-formats.test.ts.

async function openFileStep(page: Page, store: Store) {
  await loginFast(page, store)
  await openModule(page, 'Import Center')
  await page.getByRole('button', { name: 'Import from Excel / CSV' }).click()
  const dialog = page.getByRole('dialog', { name: 'Import from Excel / CSV' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Next' }).click()
  await expect(dialog.getByRole('heading', { name: 'Step 2 · Choose a file' })).toBeVisible()
  return dialog
}

const file = (name: string, text: string, mimeType = 'application/octet-stream') => ({ name, mimeType, buffer: Buffer.from(text) })

test.describe('Import from Excel / CSV — file types', () => {
  test('the supported file types are listed, and the picker offers them', async ({ page, store }) => {
    const dialog = await openFileStep(page, store)
    const list = dialog.getByTestId('supported-file-types')
    for (const ext of ['.xlsx', '.csv', '.txt', '.xml', '.json', '.pdf']) await expect(list).toContainText(ext)
    await expect(list).toContainText('not importable')
    await expect(dialog.getByLabel('Choose the file to import')).toHaveAttribute('accept', '.xlsx,.csv,.tsv,.txt,.xml,.json,.pdf')
  })

  test('XML and JSON are accepted; PDF, old Excel and unknown types are refused with a reason', async ({ page, store }) => {
    const dialog = await openFileStep(page, store)
    const input = dialog.getByLabel('Choose the file to import')
    await input.setInputFiles(file('master.xml', '<ENVELOPE><BODY/></ENVELOPE>', 'text/xml'))
    await expect(dialog.getByText('master.xml ·')).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Next' })).toBeEnabled()
    await input.setInputFiles(file('parties.json', '[{"name":"A"}]', 'application/json'))
    await expect(dialog.getByRole('button', { name: 'Next' })).toBeEnabled()
    await input.setInputFiles(file('report.pdf', '%PDF-1.7', 'application/pdf'))
    await expect(dialog.getByRole('alert').filter({ hasText: 'PDF files cannot be imported' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Next' })).toBeDisabled()
    await input.setInputFiles(file('old.xls', 'x'))
    await expect(dialog.getByRole('alert').filter({ hasText: 'Save As' })).toBeVisible()
    await input.setInputFiles(file('setup.exe', 'x'))
    await expect(dialog.getByRole('alert').filter({ hasText: 'Files of this type cannot be imported' })).toBeVisible()
  })

  test('Tally vouchers are offered as a check-only data type', async ({ page, store }) => {
    const dialog = await openFileStep(page, store)
    await dialog.getByLabel('Choose the file to import').setInputFiles(file('voucher.xml', '<ENVELOPE/>', 'text/xml'))
    await dialog.getByRole('button', { name: 'Next' }).click()
    const choice = dialog.getByRole('radio', { name: /Tally Vouchers \(XML\)/ })
    await expect(choice).toBeVisible()
    await expect(choice).toContainText('Check only')
    // XML is sent gzip-compressed by the browser itself (the server unpacks it with a size cap)
    const sent = page.waitForRequest((r) => r.url().includes('/api/import-center/parse') && r.method() === 'POST')
    await choice.click()
    const body = (await sent).postDataBuffer() ?? Buffer.alloc(0)
    expect(body.toString('latin1')).toContain('name="encoding"\r\n\r\ngzip')
    expect(body.includes(Buffer.from([0x1f, 0x8b, 0x08]))).toBe(true)
    expect(body.toString('latin1')).not.toContain('<ENVELOPE/>') // the XML itself is not sent as plain text
  })
})

// ---------------------------------------------------------------- full XML workflow

const FIXTURES = join(process.cwd(), 'e2e/fixtures')
const MASTERS_XML = readFileSync(join(FIXTURES, 'tally-masters.xml'))
const API = JSON.parse(readFileSync(join(FIXTURES, 'tally-masters.api.json'), 'utf8'))

/** The fields and the file of a multipart/form-data body, as the browser sent it. */
function multipart(body: Buffer, contentType: string): { fields: Record<string, string>; file: Buffer | null; fileName: string } {
  const boundary = Buffer.from(`--${/boundary=([^;]+)/.exec(contentType)![1]}`)
  const out = { fields: {} as Record<string, string>, file: null as Buffer | null, fileName: '' }
  let at = body.indexOf(boundary)
  while (at >= 0) {
    const next = body.indexOf(boundary, at + boundary.length)
    if (next < 0) break
    const part = body.subarray(at + boundary.length + 2, next - 2) // between "--b\r\n" and "\r\n--b"
    const split = part.indexOf('\r\n\r\n')
    const head = part.subarray(0, split).toString('utf8')
    const content = part.subarray(split + 4)
    const name = /name="([^"]+)"/.exec(head)?.[1] ?? ''
    const fileName = /filename="([^"]*)"/.exec(head)?.[1]
    if (fileName !== undefined) { out.file = Buffer.from(content); out.fileName = fileName } else out.fields[name] = content.toString('utf8')
    at = next
  }
  return out
}

const reply = (route: Route, data: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(status === 200 ? { success: true, data } : { success: false, error: { code: 'E2E', message: String(data) } }) })
const card = (dialog: ReturnType<Page['getByRole']>, label: string) => dialog.getByText(label, { exact: true }).locator('xpath=../..')

test.describe('Import from Excel / CSV — full Tally XML workflow', () => {
  test('upload → parse → data type → mapping → preview in parts (duplicates across parts) → validate → confirm → import', async ({ page, store }) => {
    const seen = { parse: 0, preview: [] as number[][], commit: [] as number[][] }
    const dataLines = (body: { table: { line: number }[] }) => body.table.slice(1).map((r) => r.line)
    await page.route('**/api/import-center/parse', async (route) => {
      const req = route.request()
      const form = multipart(req.postDataBuffer() ?? Buffer.alloc(0), req.headers()['content-type'] ?? '')
      // Chromium compressed the XML itself; unpacked, it is the file byte for byte
      if (form.fields.encoding !== 'gzip' || !form.file || !gunzipSync(form.file).equals(MASTERS_XML) || form.fields.dataType !== 'customers') {
        return reply(route, 'The upload was not the compressed fixture', 400)
      }
      seen.parse++
      return reply(route, API.parse)
    })
    await page.route('**/api/import-center/preview', async (route) => {
      const body = route.request().postDataJSON()
      const lines = dataLines(body)
      seen.preview.push(lines)
      const part = API.preview.find((p: { rows: { line: number }[] }) => p.rows.map((r) => r.line).join() === lines.join())
      const sameMapping = JSON.stringify(body.mapping) === JSON.stringify(API.parse.suggestion.mapping) && body.headerRow === 0
      return part && sameMapping ? reply(route, part) : reply(route, 'Unexpected preview request', 400)
    })
    await page.route('**/api/import-center/commit', async (route) => {
      const body = route.request().postDataJSON()
      const lines = dataLines(body)
      seen.commit.push(lines)
      const part = API.commit.find((p: { rows: { line: number }[] }) => p.rows.map((r) => r.line).join() === lines.join())
      return part && body.confirm === true ? reply(route, part) : reply(route, 'Unexpected commit request', 400)
    })

    const dialog = await openFileStep(page, store)
    // 1 upload
    await dialog.getByLabel('Choose the file to import').setInputFiles({ name: 'tally-masters.xml', mimeType: 'text/xml', buffer: MASTERS_XML })
    await dialog.getByRole('button', { name: 'Next' }).click()
    // 2 data type → parse
    await dialog.getByRole('radio', { name: /^Customers/ }).click()
    const parsed = dialog.getByTestId('parsed-file')
    await expect(parsed).toContainText('Tally XML')
    await expect(parsed).toContainText('505 rows found')
    await expect(parsed).toContainText('2 parts of 500')
    await expect(dialog).toContainText('Demo Fixture Co')
    await expect(dialog.getByRole('combobox').filter({ hasText: 'Sundry Debtors ledgers (customers) (505)' })).toBeVisible()
    await dialog.getByRole('button', { name: 'Next' }).click()
    // 3 mapping and preview (two parts, duplicates across the whole file)
    await expect(card(dialog, 'Total records')).toContainText('505', { timeout: 30_000 })
    await expect(card(dialog, 'Ready to import')).toContainText('503')
    await expect(card(dialog, 'Errors')).toContainText('1')
    await expect(card(dialog, 'Duplicates')).toContainText('1')
    await expect(dialog.getByText(/Customer name ← “Party Name”/)).toBeVisible()
    await expect(dialog.getByText(/GSTIN ← “GSTIN”/)).toBeVisible()
    await dialog.getByRole('button', { name: 'Errors and duplicates' }).click()
    await expect(dialog.getByRole('row').filter({ hasText: 'Tally GST data does not agree' })).toContainText('Party 010')
    await expect(dialog.getByRole('row').filter({ hasText: 'Same name “PARTY 003” as row 4 earlier in this file' })).toContainText('506')
    await expect(dialog.getByText('duplicates are found across the whole file')).toBeVisible()
    // 4 validate: nothing goes on before the mapping is confirmed
    await expect(dialog.getByRole('button', { name: 'Next' })).toBeDisabled()
    await dialog.getByLabel('Columns checked').click()
    await dialog.getByRole('button', { name: 'Next' }).click()
    // 5 confirm
    await expect(dialog.getByText('Rows to import:')).toContainText('503')
    await dialog.getByRole('button', { name: 'Yes, import' }).click()
    // 6 result
    await expect(dialog.getByRole('heading', { name: /Import finished/ })).toBeVisible({ timeout: 30_000 })
    await expect(card(dialog, 'Imported')).toContainText('503')
    await expect(card(dialog, 'Skipped duplicates')).toContainText('1')
    await expect(card(dialog, 'Failed')).toContainText('1')

    expect(seen.parse).toBe(1)
    expect(seen.preview.map((l) => l.length)).toEqual([500, 5])
    expect(seen.commit.map((l) => l.length)).toEqual([500, 4])
    expect(seen.commit.flat()).not.toContain(506) // the repeat was never sent to the import
  })
})
