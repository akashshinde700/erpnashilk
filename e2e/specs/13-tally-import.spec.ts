import { test, expect, loginFast, openModule } from '../support/fixtures'
import type { Locator, Page } from '@playwright/test'
import type { Store } from '../support/store'

// Import from Tally (tally-import.tsx) against the mock connector in e2e/support/mock-api.ts, which answers with the
// same shapes as the real routes. Real pairing, jobs and imports are covered by tests/tally-*.test.ts (bun, MySQL).

type Json = Record<string, unknown>
const DATA: Record<string, Json> = {
  'export-customers': { total: 5, ready: 3, duplicates: 1, errors: 1 },
  'export-suppliers': { total: 2, ready: 2, duplicates: 0, errors: 0 },
  'export-items': { total: 4, ready: 1, duplicates: 3, errors: 0 },
}

function tallyScenario(store: Store, state: string, companies: (string | { name: string; guid?: string })[] = ['Shree & Sons Pvt Ltd', 'Trial Co', 'Ganesh Traders']) {
  store.collections['tally-connector'] = [{ state, companies, data: DATA }]
}

async function openTallyImport(page: Page, store: Store) {
  await loginFast(page, store)
  await openModule(page, 'Import Center')
  await page.getByRole('button', { name: 'Import from Tally' }).click()
  // a full workspace page beside the sidebar (no longer a dialog); the variable keeps its old name
  const dialog = page.getByRole('region', { name: 'Tally Import Center' })
  await expect(dialog).toBeVisible()
  return dialog
}

const commits = (store: Store) => (store.collections['tally-import-calls'] ?? []).filter((c) => c.mode === 'commit')

test.describe('Import from Tally (connector)', () => {
  test('an already paired connector goes straight to the company list; search and choose', async ({ page, store }) => {
    tallyScenario(store, 'connected')
    const dialog = await openTallyImport(page, store)
    await expect(dialog.getByRole('heading', { name: 'Which Tally company?' })).toBeVisible()
    await expect(dialog.getByRole('radio')).toHaveCount(3)
    await dialog.getByRole('textbox', { name: 'Search companies' }).fill('trial')
    await expect(dialog.getByRole('radio')).toHaveCount(1)
    await dialog.getByRole('radio', { name: /Trial Co/ }).click()
    await expect(dialog.getByRole('radio', { name: /Trial Co/ })).toHaveAttribute('aria-checked', 'true')
    await dialog.getByRole('button', { name: 'Next' }).click()
    await expect(dialog.getByText('Tally company:')).toContainText('Trial Co')
  })

  test('not paired: stays on Connect, offers Connect Tally, cannot continue', async ({ page, store }) => {
    tallyScenario(store, 'not_paired')
    const dialog = await openTallyImport(page, store)
    await expect(dialog.getByTestId('tally-pairing-intro')).toContainText('Authorize the Tally connector (one time)')
    await expect(dialog.getByTestId('tally-connector')).toContainText('Not connected')
    await expect(dialog.getByRole('button', { name: 'Connect Tally' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Next' })).toBeDisabled()
  })

  test('automatic connection: a connector that connects while step 1 is open moves on and lists the companies by itself', async ({ page, store }) => {
    tallyScenario(store, 'connecting')
    const dialog = await openTallyImport(page, store)
    // no "Connect Tally" screen for a paired connector: the connection screen, with only confirmed steps done
    await expect(dialog.getByTestId('tally-auto-connect')).toBeVisible()
    await expect(dialog.getByTestId('connect-step-search')).toHaveAttribute('data-state', 'done')
    await expect(dialog.getByTestId('connect-step-availability')).toHaveAttribute('data-state', 'active')
    await expect(dialog.getByTestId('connect-step-tally')).toHaveAttribute('data-state', 'pending')
    await expect(dialog.getByRole('button', { name: 'Connect Tally' })).toHaveCount(0)
    store.collections['tally-connector'][0].state = 'connected'
    await expect(dialog.getByRole('heading', { name: 'Which Tally company?' })).toBeVisible({ timeout: 20_000 })
    await expect(dialog.getByTestId('tally-flow')).toHaveAttribute('data-state', 'companies_available')
    await expect(dialog.getByTestId('tally-flow')).toContainText('Companies available')
    await expect(dialog.getByRole('radio')).toHaveCount(3)
    await expect(dialog.getByTestId('tally-connector')).toHaveCount(0)
  })

  test('first time: device authorization required, then the one-time code with the install step', async ({ page, store }) => {
    tallyScenario(store, 'not_paired')
    const dialog = await openTallyImport(page, store)
    await expect(dialog.getByTestId('tally-pairing-intro')).toContainText('one-time code')
    await expect(dialog.getByTestId('tally-auto-connect')).toHaveCount(0) // never shown as connecting while unauthorised
    await dialog.getByRole('button', { name: 'Connect Tally' }).click()
    await expect(dialog.getByTestId('pairing-code')).toHaveText('ABCDE-FGHJK')
    await expect(dialog).toContainText('install-connector.ps1')
    await expect(dialog).toContainText('needed once per computer')
  })

  test('authentication failed: says so, offers Pair again, cannot continue', async ({ page, store }) => {
    tallyScenario(store, 'auth_failed')
    const dialog = await openTallyImport(page, store)
    await expect(dialog.getByTestId('tally-pairing-intro')).toContainText('This computer must be authorized again')
    await expect(dialog.getByTestId('tally-connector')).toContainText('offline too long')
    await expect(dialog.getByRole('button', { name: 'Pair again' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Next' })).toBeDisabled()
  })

  test('TallyPrime not reachable: keeps trying, then explains; connector details offer no re-pairing as the normal action', async ({ page, store }) => {
    await page.clock.install()
    tallyScenario(store, 'tally_error')
    const dialog = await openTallyImport(page, store)
    await expect(dialog.getByTestId('connect-step-auth')).toHaveAttribute('data-state', 'done')
    await expect(dialog.getByTestId('connect-step-tally')).toHaveAttribute('data-state', 'active')
    await page.clock.fastForward(80_000)
    const error = dialog.getByTestId('tally-connect-error')
    await expect(error).toContainText('TallyPrime is not reachable', { timeout: 20_000 })
    await expect(error.getByRole('button', { name: 'Retry' })).toBeVisible()
    await error.getByText('Connector details').click()
    await expect(dialog.getByTestId('tally-connector')).toContainText('ACCOUNTS-PC')
    await expect(dialog.getByRole('button', { name: 'Reconnect' })).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: 'Pair another computer' })).toBeVisible()
  })

  test('two open companies with the same name cannot be chosen', async ({ page, store }) => {
    tallyScenario(store, 'connected', [{ name: 'Same Co', guid: 'g1' }, { name: 'Same Co', guid: 'g2' }, { name: 'Other Co', guid: 'g3' }])
    const dialog = await openTallyImport(page, store)
    await expect(dialog.getByRole('radio')).toHaveCount(3)
    for (const r of await dialog.getByRole('radio', { name: /Same Co/ }).all()) await expect(r).toBeDisabled()
    await expect(dialog.getByRole('radio', { name: /Same Co/ }).first()).toContainText('same name')
    await dialog.getByRole('radio', { name: /Other Co/ }).click()
    await expect(dialog.getByRole('button', { name: 'Next' })).toBeEnabled()
  })

  test('connection lost on a later step: the dialog shows it is reconnecting', async ({ page, store }) => {
    tallyScenario(store, 'connected')
    const dialog = await openTallyImport(page, store)
    await expect(dialog.getByRole('heading', { name: 'Which Tally company?' })).toBeVisible()
    store.collections['tally-connector'][0].state = 'reconnecting'
    await expect(dialog.getByTestId('tally-connection-warning')).toContainText('Reconnecting', { timeout: 20_000 })
    store.collections['tally-connector'][0].state = 'connected'
    await expect(dialog.getByTestId('tally-connection-warning')).toHaveCount(0, { timeout: 20_000 })
  })

  test('data step: period and unsupported data are visible but cannot be chosen', async ({ page, store }) => {
    tallyScenario(store, 'connected')
    const dialog = await openTallyImport(page, store)
    await dialog.getByRole('radio', { name: /Shree & Sons/ }).click()
    await dialog.getByRole('button', { name: 'Next' }).click()
    const period = dialog.getByTestId('tally-period')
    await expect(period).toContainText('not available yet')
    for (const p of [/Current financial year/, /Last financial year/, /All data/, /Custom date range/]) {
      await expect(period.getByRole('radio', { name: p })).toBeDisabled()
    }
    // the dates each period would cover come from the Tally company (books from 1 Apr 2024 in the mock)
    await expect(dialog.getByTestId('tally-period-all')).toContainText(/1 Apr 2024|01[-/ ]04[-/ ]2024/)
    await expect(dialog.getByTestId('tally-period-all')).toContainText('financial years')
    await expect(dialog.getByTestId('tally-period-current-fy')).not.toHaveText('…')
    // the six masters can be chosen (review copy); the other 23 types are listed with their real status and cannot be
    for (const name of ['Ledgers', 'Ledger groups', 'Stock groups', 'Units', 'Godowns / locations', 'Cost centres']) {
      await expect(dialog.getByTestId('tally-masters-choice').getByRole('checkbox', { name, exact: true })).toBeEnabled()
    }
    await expect(dialog.getByRole('button', { name: /23 more data types/ })).toHaveAttribute('aria-expanded', 'false') // collapsed at first
    await dialog.getByRole('button', { name: /more data types/ }).click()
    const unavailable = dialog.getByTestId('tally-unavailable')
    for (const name of ['Sales (In development)', 'Journal (In development)', 'Trial balance (Blocked by dependency)', 'Opening stock (Requires configuration)']) {
      await expect(unavailable.getByRole('checkbox', { name })).toBeDisabled()
    }
    await expect(unavailable.getByRole('checkbox')).toHaveCount(23)
    await expect(unavailable).not.toContainText('Coming soon')
    await expect(dialog.getByTestId('tally-type-journal')).toContainText('General ledger')
    await dialog.getByRole('button', { name: 'Select all' }).click()
    for (const name of ['Customers', 'Suppliers', 'Stock items']) await expect(dialog.getByRole('checkbox', { name, exact: true })).toBeChecked()
    await expect(dialog.getByRole('button', { name: 'Next' })).toBeDisabled() // item type still needed
    await dialog.getByLabel('New stock items are').selectOption({ index: 1 })
    await expect(dialog.getByRole('button', { name: 'Next' })).toBeEnabled()
  })

  test('preview, explicit confirmation, real progress counts and the final summary', async ({ page, store }) => {
    tallyScenario(store, 'connected')
    const dialog = await openTallyImport(page, store)
    await dialog.getByRole('radio', { name: /Shree & Sons/ }).click()
    await dialog.getByRole('button', { name: 'Next' }).click()
    await dialog.getByRole('button', { name: 'Select all' }).click()
    await dialog.getByLabel('New stock items are').selectOption({ index: 1 })
    await dialog.getByRole('button', { name: 'Next' }).click()

    // preview: counts per data type, nothing saved
    await expect(dialog.getByText('Preview — nothing is saved')).toBeVisible()
    const row = (name: string) => dialog.getByRole('row').filter({ has: page.getByRole('rowheader', { name }) })
    await expect(row('Customers')).toContainText(/5\s*3\s*1\s*1/)
    await expect(dialog.getByText('Bad record 1')).toBeVisible()
    await dialog.getByRole('button', { name: 'Import data' }).click()

    // explicit confirmation; nothing committed until "Yes, import"
    const confirm = dialog.getByTestId('tally-confirm')
    await expect(confirm).toContainText('Import 6 new records')
    expect(commits(store)).toEqual([])
    await confirm.getByRole('button', { name: 'Cancel' }).click()
    await expect(confirm).toHaveCount(0)
    expect(commits(store)).toEqual([])
    await dialog.getByRole('button', { name: 'Import data' }).click()
    await dialog.getByTestId('tally-confirm').getByRole('button', { name: 'Yes, import' }).click()

    const progress = dialog.getByTestId('tally-progress')
    await expect(progress).toContainText('100%')
    await expect(progress).toContainText(/Processed\s*11 of 11/)
    await expect(progress).toContainText(/Remaining\s*0/)
    await expect(progress).toContainText(/Imported\s*6/)
    await expect(progress).toContainText(/Skipped \(already in ManuFlow\)\s*4/)
    await expect(progress).toContainText(/Not imported\s*1/)
    await expect(dialog.getByText('Import finished')).toBeVisible()
    await expect(dialog.getByText(/6 imported · 4 already in ManuFlow \(skipped\) · 1 not imported/)).toBeVisible()
    expect(commits(store).map((c) => c.dataType).sort()).toEqual(['customers', 'items', 'suppliers'])
  })

  test('Change company: the import reads the newly chosen company', async ({ page, store }) => {
    tallyScenario(store, 'connected')
    const dialog = await openTallyImport(page, store)
    await dialog.getByRole('radio', { name: /Shree & Sons/ }).click()
    await dialog.getByRole('button', { name: 'Next' }).click()
    await dialog.getByRole('checkbox', { name: 'Customers', exact: true }).click()
    await dialog.getByRole('button', { name: 'Change company' }).click()
    await expect(dialog.getByRole('heading', { name: 'Which Tally company?' })).toBeVisible()
    await dialog.getByRole('radio', { name: /Ganesh Traders/ }).click()
    await dialog.getByRole('button', { name: 'Next' }).click()
    await expect(dialog.getByText('Tally company:')).toContainText('Ganesh Traders')
    await expect(dialog.getByRole('checkbox', { name: 'Customers', exact: true })).toBeChecked() // the data choice is kept
    await dialog.getByRole('button', { name: 'Next' }).click()
    await expect(dialog.getByRole('button', { name: 'Import data' })).toBeVisible()
    const previews = (store.collections['tally-import-calls'] ?? []).filter((c) => c.mode === 'preview')
    expect(previews.map((c) => c.tallyCompany)).toEqual(['Ganesh Traders'])
  })
})

test.describe('Import from Tally — full workspace page', () => {
  test('opens as a page beside the sidebar (no dialog); Back to Import Center and Escape return; the sidebar stays usable', async ({ page, store }) => {
    tallyScenario(store, 'connected')
    const workspace = await openTallyImport(page, store)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(workspace.getByRole('heading', { name: 'Tally Import Center', level: 2 })).toBeFocused()
    await expect(workspace.getByRole('list', { name: 'Import steps' })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'New Import' })).toHaveCount(0) // the workspace takes the Import Center content's place (the top bar still names the module)
    await expect(workspace.getByRole('heading', { name: 'Which Tally company?' })).toBeVisible({ timeout: 20_000 })
    await expect(workspace.getByTestId('tally-actions').getByRole('button', { name: 'Next' })).toBeVisible()
    await workspace.getByRole('button', { name: 'Back to Import Center' }).click()
    await expect(workspace).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Import from Tally' })).toBeVisible()
    // Escape leaves the workspace too, as it closed the dialog
    await page.getByRole('button', { name: 'Import from Tally' }).click()
    await expect(page.getByRole('region', { name: 'Tally Import Center' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('region', { name: 'Tally Import Center' })).toHaveCount(0)
    // Escape that closes the command palette does not also leave the workspace
    await page.getByRole('button', { name: 'Import from Tally' }).click()
    await page.keyboard.press('Control+k')
    await expect(page.getByRole('dialog')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('region', { name: 'Tally Import Center' })).toBeVisible()
    // the sidebar is never covered: another module opens from it
    await page.getByRole('navigation', { name: 'ERP modules' }).getByRole('button', { name: 'Dashboard', exact: true }).click()
    await expect(page).toHaveTitle(/Dashboard · ManuFlow ERP/)
    await expect(page.getByRole('region', { name: 'Tally Import Center' })).toHaveCount(0)
  })

  test('no page scrolls sideways at phone width', async ({ page, store }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    tallyScenario(store, 'connected')
    const workspace = await openTallyImport(page, store)
    await workspace.getByRole('radio', { name: /Shree & Sons/ }).click()
    const sideways = () => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
    expect(await sideways()).toBe(false)
    await workspace.getByRole('button', { name: 'Next' }).click()
    await workspace.getByRole('button', { name: 'Select all' }).click()
    await workspace.getByRole('button', { name: /more data types/ }).click()
    expect(await sideways()).toBe(false)
  })
})

test.describe('Import from Tally — GSTIN missing (one confirmation per record)', () => {
  // Synthetic parties: one with a GSTIN (ready) and two whose GST type needs one that Tally does not have
  const GST_DATA = { ...DATA, 'export-customers': { total: 3, ready: 1, duplicates: 0, errors: 0, noGstin: ['No GST Party A', 'No GST Party B'] } }
  async function toReview(page: Page, store: Store) {
    store.collections['tally-connector'] = [{ state: 'connected', companies: ['Shree & Sons Pvt Ltd'], data: GST_DATA }]
    const ws = await openTallyImport(page, store)
    await ws.getByRole('radio', { name: /Shree & Sons/ }).click()
    await ws.getByRole('button', { name: 'Next' }).click()
    await ws.getByRole('checkbox', { name: 'Customers', exact: true }).click()
    await ws.getByRole('button', { name: 'Next' }).click()
    await expect(ws.getByRole('button', { name: 'Import data' })).toBeEnabled()
    return ws
  }

  test('preview lists them apart; YES imports, NO skips that record only; the answers reach the server', async ({ page, store }) => {
    const ws = await toReview(page, store)
    await expect(ws.getByTestId('tally-gstin-missing')).toContainText('GSTIN missing — confirmation required (2)')
    const reviewRow = (name: string) => ws.getByTestId('tally-review-row').filter({ hasText: name })
    await expect(reviewRow('No GST Party A')).toContainText('GSTIN Missing')
    await expect(reviewRow('No GST Party A')).toContainText('Confirmation required')
    await ws.getByRole('button', { name: 'Import data' }).click()

    const dialog = page.getByRole('alertdialog', { name: 'GSTIN Missing' })
    await expect(dialog).toContainText('The GSTIN for No GST Party A is not available in Tally. Are you sure you want to import this Customer without GSTIN?')
    await expect(dialog).toContainText('Record 1 of 2')
    await dialog.getByRole('button', { name: 'Yes, import without GSTIN' }).click()
    await expect(dialog).toContainText('No GST Party B')
    await dialog.getByRole('button', { name: 'No, skip this record' }).click()
    await expect(dialog).toHaveCount(0)

    const confirm = ws.getByTestId('tally-confirm')
    await expect(confirm).toContainText('Import 2 new records')
    await expect(confirm).toContainText('1 imported with the GSTIN left empty, 1 skipped by you')
    expect(commits(store)).toEqual([])
    await confirm.getByRole('button', { name: 'Yes, import' }).click()
    await expect(ws.getByText('Import finished')).toBeVisible()
    await expect(ws.getByText(/2 imported · 0 already in ManuFlow \(skipped\) · 0 not imported · 1 skipped by you \(no GSTIN\)/)).toBeVisible()
    await expect(ws.getByTestId('tally-gstin-declined')).toContainText('No GST Party B')
    expect(commits(store).map((c) => c.gstinDecisions)).toEqual([{ 100: 'import', 101: 'skip' }])
  })

  test('cancelling the import imports nothing and asks again next time', async ({ page, store }) => {
    const ws = await toReview(page, store)
    await ws.getByRole('button', { name: 'Import data' }).click()
    const dialog = page.getByRole('alertdialog', { name: 'GSTIN Missing' })
    await dialog.getByRole('button', { name: 'Yes, import without GSTIN' }).click()
    await dialog.getByRole('button', { name: 'Cancel import' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(ws.getByTestId('tally-confirm')).toHaveCount(0)
    expect(commits(store)).toEqual([])
    // Escape cancels too, and the workspace stays open
    await ws.getByRole('button', { name: 'Import data' }).click()
    await expect(dialog).toContainText('No GST Party A') // the earlier answer was dropped with the cancel
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(ws).toBeVisible()
    expect(commits(store)).toEqual([])
  })
})

test.describe('Tally Import Center — review dashboard', () => {
  async function toReview(page: Page, store: Store, data: Json = DATA) {
    store.collections['tally-connector'] = [{ state: 'connected', companies: ['Shree & Sons Pvt Ltd'], data }]
    const ws = await openTallyImport(page, store)
    await ws.getByRole('radio', { name: /Shree & Sons/ }).click()
    await ws.getByRole('button', { name: 'Next' }).click()
    await ws.getByRole('button', { name: 'Select all' }).click()
    await ws.getByLabel('New stock items are').selectOption({ index: 1 })
    await ws.getByRole('button', { name: 'Next' }).click()
    await expect(ws.getByRole('button', { name: 'Import data' })).toBeEnabled()
    return ws
  }
  const card = (ws: Locator, key: string) => ws.getByTestId(`tally-card-${key}`)
  const rows = (ws: Locator) => ws.getByTestId('tally-review-row')

  test('cards show the preview counts; the stage indicator, type / status / search filters and the empty state work', async ({ page, store }) => {
    const ws = await toReview(page, store)
    await expect(ws.getByRole('list', { name: 'Import steps' }).locator('[aria-current="step"]')).toContainText('Review & Confirm')
    // counts come from the preview: 11 records; 6 new, 4 already there, 1 invalid, no GSTIN question
    await expect(card(ws, 'all')).toContainText('11')
    await expect(card(ws, 'ready')).toContainText('6')
    await expect(card(ws, 'gstin')).toContainText('0')
    await expect(card(ws, 'existing')).toContainText('4')
    await expect(card(ws, 'invalid')).toContainText('1')
    await expect(card(ws, 'skip')).toContainText('0')
    await expect(rows(ws)).toHaveCount(11)
    await expect(rows(ws).filter({ hasText: 'Bad record 1' })).toContainText('Invalid')
    await expect(rows(ws).filter({ hasText: 'Bad record 1' })).toContainText('GSTIN is not valid')
    await expect(rows(ws).filter({ hasText: 'Existing Item 1' })).toContainText('Already Exists')
    await expect(rows(ws).filter({ hasText: 'Ready Customer 1' })).toContainText('Ready to Import')
    // data type filter
    await ws.getByRole('group', { name: 'Data type' }).getByRole('button', { name: /Customers/ }).click()
    await expect(rows(ws)).toHaveCount(5)
    // a card filters by status, and clicking it again shows everything
    await ws.getByRole('group', { name: 'Data type' }).getByRole('button', { name: /All/ }).click()
    await card(ws, 'existing').click()
    await expect(rows(ws)).toHaveCount(4)
    await card(ws, 'existing').click()
    await expect(rows(ws)).toHaveCount(11)
    // search by name; nothing found → empty state with Clear filters
    await ws.getByRole('textbox', { name: 'Search records' }).fill('ready supplier')
    await expect(rows(ws)).toHaveCount(2)
    await ws.getByRole('textbox', { name: 'Search records' }).fill('no such party')
    await expect(ws.getByTestId('tally-review-empty')).toContainText('No records match these filters.')
    await ws.getByTestId('tally-review-empty').getByRole('button', { name: 'Clear filters' }).click()
    await expect(rows(ws)).toHaveCount(11)
    // the summary panel repeats the same counts
    await expect(ws.getByTestId('tally-side-summary')).toContainText(/Ready to import\s*6/)
  })

  test('per-record review, bulk skip, customers and suppliers kept apart; result screen and Import History', async ({ page, store }) => {
    const ws = await toReview(page, store, {
      ...DATA,
      'export-customers': { total: 3, ready: 1, duplicates: 0, errors: 0, noGstin: ['No GST Party A', 'No GST Party B'] },
      'export-suppliers': { total: 2, ready: 1, duplicates: 0, errors: 0, noGstin: ['No GST Supplier S'] },
    })
    await expect(card(ws, 'gstin')).toContainText('3')
    await expect(ws.getByTestId('tally-action-status')).toContainText('3 GSTIN confirmations pending')
    const row = (name: string) => rows(ws).filter({ hasText: name })
    const dialog = page.getByRole('alertdialog', { name: 'GSTIN Missing' })

    // review one record from the table: yes
    await row('No GST Party A').getByRole('button', { name: 'Review No GST Party A' }).click()
    await expect(dialog).toContainText('Are you sure you want to import this Customer without GSTIN?')
    await dialog.getByRole('button', { name: 'Yes, Import without GSTIN' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(row('No GST Party A')).toContainText('Import without GSTIN')
    // Close (from the table) keeps every answer and answers nothing
    await row('No GST Party B').getByRole('button', { name: 'Review No GST Party B' }).click()
    await dialog.getByRole('button', { name: 'Close' }).click()
    await expect(row('No GST Party B')).toContainText('Confirmation required')
    await expect(row('No GST Party A')).toContainText('Import without GSTIN')

    // bulk: select the customer B and the supplier S, then skip them (an explicit no for each)
    await row('No GST Party B').getByRole('checkbox').check()
    await row('No GST Supplier S').getByRole('checkbox').check()
    await expect(ws.getByTestId('tally-bulk')).toContainText('2 selected')
    await ws.getByTestId('tally-bulk').getByRole('button', { name: 'Skip selected' }).click()
    await expect(row('No GST Party B')).toContainText('Skipped')
    await expect(row('No GST Supplier S')).toContainText('Skipped')
    await expect(card(ws, 'skip')).toContainText('2')
    await expect(ws.getByTestId('tally-action-status')).toContainText('0 GSTIN confirmations pending')

    // every record answered: no dialog, straight to the final confirmation
    await ws.getByRole('button', { name: 'Import data' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(ws.getByTestId('tally-confirm')).toContainText('1 imported with the GSTIN left empty, 2 skipped by you')
    await ws.getByTestId('tally-confirm').getByRole('button', { name: 'Yes, import' }).click()

    // the result comes from the server's replies; each data type got only its own answers
    const result = ws.getByTestId('tally-result')
    await expect(result).toContainText('Import finished')
    await expect(ws.getByRole('list', { name: 'Import steps' }).locator('[aria-current="step"]')).toContainText('Result')
    await expect(result.getByTestId('tally-result-card').filter({ hasText: 'Successfully Imported' })).toContainText('4') // 1 + 1 confirmed customers, 1 supplier, 1 item
    await expect(result.getByTestId('tally-result-card').filter({ hasText: /^Skipped/ })).toContainText('2')
    await expect(ws.getByTestId('tally-gstin-declined')).toContainText('No GST Party B')
    await expect(ws.getByTestId('tally-gstin-declined')).toContainText('No GST Supplier S')
    const byType = Object.fromEntries(commits(store).map((c) => [c.dataType, c.gstinDecisions]))
    expect(byType.customers).toEqual({ 100: 'import', 101: 'skip' })
    expect(byType.suppliers).toEqual({ 100: 'skip' })

    await result.getByRole('button', { name: 'View Import History' }).click()
    await expect(page.getByRole('region', { name: 'Tally Import Center' })).toHaveCount(0)
    await expect(page.getByRole('tab', { name: 'History' })).toHaveAttribute('aria-selected', 'true')
  })
})

test.describe('Import from Tally — automatic connection', () => {
  const tc = (store: Store) => store.collections['tally-connector'][0]

  test('a dropped connection to ManuFlow is retried by itself', async ({ page, store }) => {
    tallyScenario(store, 'connected')
    tc(store).statusFailures = 2
    const dialog = await openTallyImport(page, store)
    await expect(dialog.getByRole('heading', { name: 'Which Tally company?' })).toBeVisible({ timeout: 20_000 })
    expect(tc(store).statusChecks).toBeGreaterThanOrEqual(3)
  })

  test('connector offline: stops waiting with a clear reason; Retry connects once it is back', async ({ page, store }) => {
    await page.clock.install()
    tallyScenario(store, 'offline')
    const dialog = await openTallyImport(page, store)
    await expect(dialog.getByTestId('connect-step-availability')).toHaveAttribute('data-state', 'active')
    await page.clock.fastForward(80_000)
    const error = dialog.getByTestId('tally-connect-error')
    await expect(error).toContainText('The Tally connector is not responding', { timeout: 20_000 })
    await expect(error).toContainText('What you can do')
    await expect(dialog.getByTestId('tally-auto-connect')).toHaveCount(0) // no endless spinner
    tc(store).state = 'connected'
    await error.getByRole('button', { name: 'Retry' }).click()
    await expect(dialog.getByRole('heading', { name: 'Which Tally company?' })).toBeVisible({ timeout: 20_000 })
  })

  test('company list read fails once: tried again by itself', async ({ page, store }) => {
    tallyScenario(store, 'connected')
    tc(store).listFailures = 1
    const dialog = await openTallyImport(page, store)
    await expect(dialog.getByRole('heading', { name: 'Which Tally company?' })).toBeVisible({ timeout: 20_000 })
    await expect(dialog.getByRole('radio')).toHaveCount(3)
  })

  test('company list keeps failing: explained with Retry, which reads it again', async ({ page, store }) => {
    tallyScenario(store, 'connected')
    tc(store).listFailures = 3
    const dialog = await openTallyImport(page, store)
    const error = dialog.getByTestId('tally-connect-error')
    await expect(error).toContainText('The company list could not be read from TallyPrime', { timeout: 30_000 })
    await expect(error).toContainText('took too long')
    tc(store).listFailures = 0
    await error.getByRole('button', { name: 'Retry' }).click()
    await expect(dialog.getByRole('heading', { name: 'Which Tally company?' })).toBeVisible({ timeout: 20_000 })
  })

  test('no company open in TallyPrime: said so on the company step', async ({ page, store }) => {
    tallyScenario(store, 'connected', [])
    const dialog = await openTallyImport(page, store)
    await expect(dialog.getByText('No company is open in TallyPrime')).toBeVisible({ timeout: 20_000 })
  })

  test('connector too old / feature switched off: explained, no endless spinner', async ({ page, store }) => {
    tallyScenario(store, 'outdated')
    const dialog = await openTallyImport(page, store)
    await expect(dialog.getByTestId('tally-connect-error')).toContainText('needs an update')
    await expect(dialog.getByTestId('tally-connect-error').getByRole('button', { name: 'Retry' })).toBeVisible()
  })

  test('closing the dialog stops the checks', async ({ page, store }) => {
    tallyScenario(store, 'offline')
    const dialog = await openTallyImport(page, store)
    await expect.poll(() => tc(store).statusChecks ?? 0).toBeGreaterThanOrEqual(2)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    const after = tc(store).statusChecks
    await page.waitForTimeout(5000)
    expect(tc(store).statusChecks).toBe(after)
  })

  test('one status check at a time, even when the server is slow', async ({ page, store }) => {
    tallyScenario(store, 'connecting')
    let inFlight = 0
    let most = 0
    await page.route('**/api/import-center/tally/connector**', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      inFlight++; most = Math.max(most, inFlight)
      await new Promise((r) => setTimeout(r, 2500))
      inFlight--
      await route.fallback()
    })
    const dialog = await openTallyImport(page, store)
    await expect(dialog.getByTestId('tally-auto-connect')).toBeVisible()
    await page.waitForTimeout(9000)
    expect(most).toBe(1)
  })
})

test.describe('Import from Tally — masters review copy (Phase 1)', () => {
  // Review rows as the real master-review route returns them (classification worked out by the server)
  const MASTERS = {
    group: [{ guid: 'g-1', name: 'Pune Banks', parent: 'Bank Accounts', alterId: 2, data: {}, issues: [], missingSince: null, lastSeenAt: '2026-11-11T10:00:00Z', needsReview: false }],
    ledger: [
      { guid: 'l-1', name: 'HDFC Current A/c', parent: 'Pune Banks', alterId: 3, data: {}, issues: [], missingSince: null, lastSeenAt: '2026-11-11T10:00:00Z', needsReview: false, link: null,
        classification: { category: 'bank', confidence: 'exact', via: 'Bank Accounts', path: ['Pune Banks', 'Bank Accounts'], reason: 'Under Tally’s “Bank Accounts” group.' } },
      { guid: 'l-2', name: 'Odd Ledger', parent: 'Current Assets', alterId: 4, data: {}, issues: [], missingSince: null, lastSeenAt: '2026-11-11T10:00:00Z', needsReview: true, link: null,
        classification: { category: 'asset', confidence: 'review', via: 'Current Assets', path: ['Current Assets'], reason: 'Directly under Tally’s broad “Current Assets” group — confirm what this ledger is.' } },
    ],
    godown: [{ guid: 'gd-1', name: 'Bhosari Godown', parent: null, alterId: 5, data: {}, issues: [], missingSince: null, lastSeenAt: '2026-11-11T10:00:00Z', needsReview: true, link: null, suggestion: null }],
    stockgroup: [], unit: [], costcentre: [],
  }
  async function toMasters(page: Page, store: Store, pick: string[]) {
    store.collections['tally-connector'] = [{
      state: 'connected', companies: ['Shree & Sons Pvt Ltd'], masters: structuredClone(MASTERS),
      data: { ...DATA, 'export-groups': { total: 1 }, 'export-ledgers': { total: 2 }, 'export-godowns': { total: 1 } },
    }]
    const ws = await openTallyImport(page, store)
    await ws.getByRole('radio', { name: /Shree & Sons/ }).click()
    await ws.getByRole('button', { name: 'Next' }).click()
    for (const name of pick) await ws.getByTestId('tally-masters-choice').getByRole('checkbox', { name, exact: true }).check()
    await expect(ws.getByTestId('tally-action-status')).toContainText(`${pick.length} data type`)
    await ws.getByRole('button', { name: 'Next' }).click()
    return ws
  }

  test('masters only: read, reviewed with real counts, nothing imported', async ({ page, store }) => {
    const ws = await toMasters(page, store, ['Ledgers', 'Ledger groups', 'Godowns / locations'])
    await expect(ws.getByRole('heading', { name: 'Masters review' })).toBeVisible()
    const panel = ws.getByTestId('tally-masters')
    await expect(panel.getByTestId('tally-masters-unverified')).toContainText('not yet been checked against a real TallyPrime')
    await expect(panel.getByTestId('tally-master-read-ledgers')).toContainText('2 read from Tally')
    await expect(panel.getByTestId('tally-master-read-groups')).toContainText('1 read from Tally')
    // the jobs asked for are exactly the chosen masters, read-only exports
    const types = (store.collections['tally-jobs'] ?? []).map((j) => j.type).filter((t) => t !== 'list-companies').sort()
    expect(types).toEqual(['export-godowns', 'export-groups', 'export-ledgers'])
    expect(store.collections['tally-import-calls'] ?? []).toEqual([]) // no import of business data
    // ledgers tab: suggested meaning, review flag
    await panel.getByRole('tab', { name: /Ledgers/ }).click()
    const table = panel.getByTestId('tally-masters-table')
    await expect(table).toContainText('Bank account')
    await expect(table).toContainText('Needs review')
    await expect(panel.getByTestId('tally-masters-summary')).toContainText('Needs review1')
    await panel.getByRole('button', { name: 'Needs review' }).click()
    await expect(table.getByRole('row')).toHaveCount(2) // header + Odd Ledger
    await expect(table).toContainText('Odd Ledger')
    await expect(ws.getByRole('button', { name: 'Import data' })).toHaveCount(0)
    await expect(ws.getByRole('button', { name: 'Done' })).toBeVisible()
  })

  test('link a bank ledger to a bank account and a godown to a new warehouse — one explicit action each', async ({ page, store }) => {
    const ws = await toMasters(page, store, ['Ledgers', 'Godowns / locations'])
    const panel = ws.getByTestId('tally-masters')
    await expect(panel.getByTestId('tally-master-read-godowns')).toContainText('1 read from Tally')
    await panel.getByRole('tab', { name: /Ledgers/ }).click()
    const pick = panel.getByLabel('Account for HDFC Current A/c')
    await expect(pick.locator('option')).toHaveText(['Choose bank account…', 'HDFC Current', 'ICICI OD']) // bank accounts only
    await pick.selectOption({ label: 'HDFC Current' })
    await panel.getByRole('button', { name: 'Link', exact: true }).click()
    await expect(panel.getByTestId('tally-masters-table')).toContainText('Bank account — HDFC Current')
    await panel.getByRole('tab', { name: /Godowns/ }).click()
    await panel.getByRole('button', { name: 'Create warehouse' }).click()
    await expect(panel.getByTestId('tally-masters-table')).toContainText('Warehouse BHOSARI-GODOWN — Bhosari Godown')
    expect((store.collections['tally-master-links'] ?? []).map((l) => [l.kind, l.guid, l.moneyAccountId ?? null, !!l.create])).toEqual([
      ['ledger', 'l-1', 'acc_bank', false], ['godown', 'gd-1', null, true],
    ])
  })
})
