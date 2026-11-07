import { test, expect, loginFast, openModule } from '../support/fixtures'
import type { Page } from '@playwright/test'
import type { Store } from '../support/store'

// Import from Tally (tally-import.tsx) against the mock connector in e2e/support/mock-api.ts, which answers with the
// same shapes as the real routes. Real pairing, jobs and imports are covered by tests/tally-*.test.ts (bun, MySQL).

const DATA = {
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
  const dialog = page.getByRole('dialog', { name: 'Import from Tally' })
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
    await expect(dialog.getByTestId('tally-connector')).toContainText('Not connected')
    await expect(dialog.getByRole('button', { name: 'Connect Tally' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Next' })).toBeDisabled()
  })

  test('automatic connection: a connector that connects while step 1 is open moves on and lists the companies by itself', async ({ page, store }) => {
    tallyScenario(store, 'connecting')
    const dialog = await openTallyImport(page, store)
    await expect(dialog.getByTestId('tally-flow')).toHaveAttribute('data-state', 'connecting')
    await expect(dialog.getByTestId('tally-connector')).toContainText('Connecting')
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
    await expect(dialog.getByTestId('tally-flow')).toContainText('Device authorization required')
    await dialog.getByRole('button', { name: 'Connect Tally' }).click()
    await expect(dialog.getByTestId('pairing-code')).toHaveText('ABCDE-FGHJK')
    await expect(dialog).toContainText('install-connector.ps1')
    await expect(dialog).toContainText('needed once per computer')
  })

  test('authentication failed: says so, offers Pair again, cannot continue', async ({ page, store }) => {
    tallyScenario(store, 'auth_failed')
    const dialog = await openTallyImport(page, store)
    await expect(dialog.getByTestId('tally-flow')).toContainText('Authentication failed')
    await expect(dialog.getByTestId('tally-connector')).toContainText('offline too long')
    await expect(dialog.getByRole('button', { name: 'Pair again' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Next' })).toBeDisabled()
  })

  test('a connected connector offers no re-pairing as the normal action; the computer is shown', async ({ page, store }) => {
    tallyScenario(store, 'tally_error')
    const dialog = await openTallyImport(page, store)
    await expect(dialog.getByTestId('tally-flow')).toContainText('Tally not reachable')
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
    await dialog.getByRole('button', { name: /more kinds of data/ }).click()
    for (const name of ['Sales (not available yet)', 'Journal (not available yet)', 'Ledgers (bank, expenses, …) (not available yet)', 'Trial balance (not available yet)', 'Opening stock (not available yet)']) {
      await expect(dialog.getByTestId('tally-unavailable').getByRole('checkbox', { name })).toBeDisabled()
    }
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
