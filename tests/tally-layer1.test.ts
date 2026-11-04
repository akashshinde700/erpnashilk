import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { POST as createJobRoute } from '@/app/api/import-center/tally/jobs/route'
import { POST as importRoute } from '@/app/api/import-center/tally/import/route'
import { db } from '@/lib/db'
import { recordJobResult } from '@/lib/tally/jobs'
import { amountToPaise, sourceRow, stageMasters } from '@/lib/tally/layer1'
import { tallyBatchTable } from '@/lib/tally/to-import'
import * as connector from '../connector/tally/manuflow-tally-connector.mjs'
import { apiRequest, call, type TestUser } from './helpers/api'
import { resetDb } from './helpers/db'
import { seedTenant } from './helpers/seed'

// Phase E: real (anonymised) TallyPrime replies, the Layer 1 source copy of masters, and Tally GUID links.
// Fixtures: tests/fixtures/tally/real-20261103 — anonymised from one real TallyPrime capture of 2026-11-03 (company list,
// customers, suppliers, stock items of one company), reviewed before use. Nothing here contacts a real Tally.

const FIXTURES = join(process.cwd(), 'tests/fixtures/tally/real-20261103')
// The fixtures are kept out of Git until they are approved for it: without them these tests are skipped (and say so)
const HAVE_FIXTURES = existsSync(join(FIXTURES, 'list-companies.xml'))
if (!HAVE_FIXTURES) console.warn(`[tally-layer1] skipped: no fixtures in ${FIXTURES} (anonymised real captures are not in Git)`)
const fixture = (f: string) => readFileSync(join(FIXTURES, f), 'utf8')
const FILE_FOR: Record<string, string> = {
  ManuFlowCompanies: 'list-companies.xml', ManuFlowDebtors: 'export-customers.xml', ManuFlowCreditors: 'export-suppliers.xml', ManuFlowStockItems: 'export-items.xml',
}

// The anonymised company name, as the fixture has it (fakes are numbered in file order)
const COMPANY = HAVE_FIXTURES ? /<COMPANY NAME="([^"]+)"/.exec(fixture('list-companies.xml'))![1] : ''

let tally: ReturnType<typeof Bun.serve>
// a test may replace what the mock Tally answers for one collection
const override: Record<string, string> = {}
const savedFlag = process.env.TALLY_CONNECTOR_POC

beforeAll(() => {
  tally = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch(req) {
      const id = /<ID>([^<]*)<\/ID>/.exec(await req.text())?.[1] ?? ''
      if (override[id]) return new Response(override[id])
      return new Response(FILE_FOR[id] ? fixture(FILE_FOR[id]) : '<ENVELOPE><HEADER><STATUS>0</STATUS></HEADER></ENVELOPE>')
    },
  })
})
afterAll(() => {
  tally.stop(true)
  if (savedFlag === undefined) delete process.env.TALLY_CONNECTOR_POC
  else process.env.TALLY_CONNECTOR_POC = savedFlag
})
beforeEach(async () => {
  for (const k of Object.keys(override)) delete override[k]
  await resetDb()
  process.env.TALLY_CONNECTOR_POC = '1'
})

const tallyUrl = () => `http://127.0.0.1:${tally.port}`
async function read(type: string, company = COMPANY) {
  const r = await connector.runJob(tallyUrl(), { type, company })
  expect([type, r.ok]).toEqual([type, true])
  return r.records as Record<string, string>[]
}

// ---------------------------------------------------------------- the real reply structure

describe.skipIf(!HAVE_FIXTURES)('readers on real TallyPrime replies (anonymised)', () => {
  test('company list, customers, suppliers and stock items read as Tally sent them', async () => {
    expect(COMPANY).toMatch(/^Name \d{4}$/)
    expect(await read('list-companies')).toEqual([{ name: COMPANY, startingFrom: '2026-04-01', booksFrom: '2026-04-01' }])
    const [customer] = await read('export-customers')
    expect(customer).toMatchObject({ parent: 'Sundry Debtors', state: 'Maharashtra', gstType: expect.any(String), guid: expect.stringMatching(/^00000000-0000-4000-8000-\d{12}-[0-9a-f]+$/) })
    expect(customer.gstin).toBeUndefined() // empty in Tally: never invented
    expect((await read('export-suppliers'))[0]).toMatchObject({ parent: 'Sundry Creditors', state: 'Maharashtra' })
    const items = await read('export-items')
    expect(items.length).toBe(3)
    for (const i of items) expect(i).toMatchObject({ parent: 'Primary', unit: 'Nos', gstRate: '0', guid: expect.stringMatching(/^00000000-/) })
    expect(new Set(items.map((i) => i.guid)).size).toBe(3)
  })

  test('the real reply carries BODY/DESC/CMPINFO with record tag names: only BODY/DATA/COLLECTION is read', async () => {
    const clean = (await read('export-customers')).map((x) => x.name)
    const real = fixture('export-customers.xml')
    expect(real).toMatch(/<DESC>\s*<CMPINFO>[\s\S]*<LEDGER>/) // as captured
    // a named LEDGER planted in DESC (and one outside COLLECTION) must not become a record
    override.ManuFlowDebtors = real
      .replace('<CMPINFO>', '<CMPINFO><LEDGER NAME="Planted In Desc"><GUID>planted-1</GUID></LEDGER>')
      .replace('<DATA>', '<DATA><LEDGER NAME="Planted Outside Collection"><GUID>planted-2</GUID></LEDGER>')
    const records = await read('export-customers')
    expect(records.map((r) => r.name)).toEqual(clean)
    expect(clean.length).toBe(1)
  })

  test('Tally’s built-in names carry a hidden control character (&#4;): read as the plain name, kept in the fixture', async () => {
    expect(fixture('export-items.xml')).toContain('<PARENT TYPE="String">&#4; Primary</PARENT>')
    expect((await read('export-items')).every((i) => i.parent === 'Primary')).toBe(true)
    // and Primary (the root stock group) means "no group" when importing items, not a category called Primary
    const { table } = tallyBatchTable('items', [{ name: 'X', unit: 'Nos', parent: 'Primary' }, { name: 'Y', unit: 'Nos', parent: 'Fasteners' }], 0)
    expect(table.slice(1).map((r) => r.cells[4])).toEqual(['', 'Fasteners'])
  })

  test('the fixtures hold no real company name, GUID or contact data', () => {
    const all = Object.values(FILE_FOR).map(fixture).join('\n')
    expect(all).not.toMatch(/ABC Private/i)
    for (const g of all.match(/<GUID[^>]*>([^<]+)<\/GUID>/g) ?? []) expect(g).toMatch(/>00000000-0000-4000-8000-\d{12}-/)
    expect(all).not.toMatch(/\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b|@|(?<!\d)[6-9]\d{9}(?!\d)/)
  })
})

// ---------------------------------------------------------------- Layer 1

const job = (companyId: string, type: string, id = `job-${type}-${companyId}`.slice(0, 60)) => ({ id, companyId, tallyCompany: COMPANY, type })
const rows = (companyId: string) => db.tallySourceMaster.findMany({ where: { companyId }, orderBy: { name: 'asc' } })

describe.skipIf(!HAVE_FIXTURES)('Layer 1 source copy', () => {
  test('masters are saved with GUID, ALTERID, parent and source fields; re-reading is idempotent', async () => {
    const { company } = await seedTenant()
    const items = await read('export-items')
    const at1 = new Date(Date.now() - 60_000)
    expect(await stageMasters(job(company.id, 'export-items'), items, at1)).toEqual({ staged: 3, markedMissing: 0 })
    const first = await rows(company.id)
    expect(first.length).toBe(3)
    expect(first[0]).toMatchObject({ kind: 'stockitem', tallyCompany: COMPANY, parent: 'Primary', issues: null, missingSince: null })
    expect(first[0].data).toMatchObject({ unit: 'Nos', gstRate: '0' })
    expect(first.map((r) => r.guid).sort()).toEqual(items.map((i) => i.guid).sort())

    await stageMasters(job(company.id, 'export-items', 'second-read'), items)
    const again = await rows(company.id)
    expect(again.length).toBe(3)
    expect(again.map((r) => r.firstSeenAt.getTime())).toEqual(first.map((r) => r.firstSeenAt.getTime()))
    expect(again.every((r) => r.lastSeenAt > at1 && r.jobId === 'second-read')).toBe(true)
  })

  test('a later read merges fields (customer read + full ledger read of the same GUID)', async () => {
    const { company } = await seedTenant()
    await stageMasters(job(company.id, 'export-customers'), [{ guid: 'g-1', name: 'Party', parent: 'Sundry Debtors', state: 'Maharashtra', email: 'a@example.test' }])
    await stageMasters(job(company.id, 'export-ledgers'), [{ guid: 'g-1', name: 'Party', parent: 'Sundry Debtors', alterId: '41', openingBalance: '-1250.50' }])
    const [r] = await rows(company.id)
    expect(r).toMatchObject({ kind: 'ledger', alterId: 41 })
    expect(r.data).toMatchObject({ state: 'Maharashtra', email: 'a@example.test', openingBalance: '-1250.50', openingBalancePaise: -125050 })
  })

  test('records missing from a full read are marked, never deleted; they are cleared when they come back', async () => {
    const { company } = await seedTenant()
    const a = { guid: 'g-a', name: 'A', parent: 'Primary' }
    const b = { guid: 'g-b', name: 'B', parent: 'Primary' }
    await stageMasters(job(company.id, 'export-items'), [a, b], new Date(Date.now() - 120_000))
    expect((await stageMasters(job(company.id, 'export-items'), [a], new Date(Date.now() - 60_000))).markedMissing).toBe(1)
    let all = await rows(company.id)
    expect(all.map((r) => [r.name, r.missingSince !== null])).toEqual([['A', false], ['B', true]])
    // a partial read (customers are only some of the ledgers) never marks anything
    await stageMasters(job(company.id, 'export-customers'), [{ guid: 'g-c', name: 'C', parent: 'Sundry Debtors' }])
    expect((await stageMasters(job(company.id, 'export-customers'), [{ guid: 'g-d', name: 'D', parent: 'Sundry Debtors' }])).markedMissing).toBe(0)
    await stageMasters(job(company.id, 'export-items'), [a, b])
    all = await rows(company.id)
    expect(all.filter((r) => r.kind === 'stockitem').every((r) => r.missingSince === null)).toBe(true)
    expect(all.length).toBe(4) // nothing was deleted
  })

  test('records with problems are kept with clear issues', async () => {
    const { company } = await seedTenant()
    await stageMasters(job(company.id, 'export-ledgers'), [
      { name: 'No Guid Ledger', parent: 'Sundry Debtors' },
      { guid: 'g-x', name: 'Odd', parent: 'Sundry Debtors', alterId: 'abc', openingBalance: '1250.50 Dr' },
    ])
    const all = await rows(company.id)
    expect(all.find((r) => r.name === 'No Guid Ledger')).toMatchObject({ guid: 'name:No Guid Ledger', issues: [expect.objectContaining({ code: 'no_guid' })] })
    const odd = all.find((r) => r.name === 'Odd')!
    expect((odd.issues as { code: string }[]).map((i) => i.code)).toEqual(['bad_alter_id', 'bad_opening_balance'])
    expect(odd.alterId).toBeNull()
    expect((odd.data as Record<string, unknown>).openingBalancePaise).toBeUndefined() // never guessed
    expect([amountToPaise('1,234.5'), amountToPaise('-0.05'), amountToPaise('12 Cr'), amountToPaise('')]).toEqual([123450, -5, null, null])
    expect(sourceRow({ name: 'n', guid: ' ' }).issues?.[0].code).toBe('no_guid')
  })

  test('tenant isolation: the same Tally GUID in two companies is two separate rows', async () => {
    const a = await seedTenant()
    const b = await seedTenant()
    await stageMasters(job(a.company.id, 'export-items'), [{ guid: 'same', name: 'A item', parent: 'Primary' }])
    await stageMasters(job(b.company.id, 'export-items'), [{ guid: 'same', name: 'B item', parent: 'Primary' }])
    expect((await rows(a.company.id)).map((r) => r.name)).toEqual(['A item'])
    expect((await rows(b.company.id)).map((r) => r.name)).toEqual(['B item'])
  })

  test('staging writes nothing to business tables', async () => {
    const { company } = await seedTenant()
    const before = await businessCounts()
    await stageMasters(job(company.id, 'export-customers'), await read('export-customers'))
    await stageMasters(job(company.id, 'export-items'), await read('export-items'))
    expect(await businessCounts()).toEqual(before)
  })
})

/** Row counts of every table that is not a Tally table. */
async function businessCounts() {
  const tables = await db.$queryRawUnsafe<{ name: string }[]>(
    "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' AND table_name NOT LIKE 'Tally%' ORDER BY table_name",
  )
  const out: Record<string, number> = {}
  for (const { name } of tables) out[name] = Number((await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM \`${name.replaceAll('`', '')}\``))[0].n)
  return out
}

// ---------------------------------------------------------------- through the routes: jobs, staging, GUID links

/** A connector of the company whose next job is running, as after a heartbeat. */
async function connectorFor(companyId: string) {
  return db.tallyConnector.create({
    data: { id: companyId.slice(-24).padStart(24, '0'), companyId, activeFor: companyId, secretHash: 'x', pairedAt: new Date(), pairedBy: 'u', lastSeenAt: new Date(), lastTallyStatus: 'connected' },
  })
}
/** A finished export job with these records, posted the way the connector posts them (so staging runs too). */
async function finishedJob(companyId: string, type: string, records: Record<string, string>[]) {
  const c = (await db.tallyConnector.findUnique({ where: { activeFor: companyId } })) ?? await connectorFor(companyId)
  const id = `${type}-${Math.random().toString(16).slice(2, 10)}`
  await db.tallyJob.create({ data: { id, companyId, connectorId: c.id, type, tallyCompany: COMPANY, status: 'running', createdBy: 'u', startedAt: new Date(), leaseUntil: new Date(Date.now() + 60_000) } })
  expect((await recordJobResult(c, { jobId: id, ok: true, records })).accepted).toBe(true)
  return id
}
const importBatch = (user: TestUser, jobId: string, dataType: string, mode: 'preview' | 'commit', options: Record<string, string> = {}) =>
  call(importRoute(apiRequest('/api/import-center/tally/import', { body: { jobId, dataType, mode, batch: 0, confirm: mode === 'commit', options }, user })))

describe.skipIf(!HAVE_FIXTURES)('jobs, staging and Tally GUID links', () => {
  test('a finished master export is staged in Layer 1 automatically', async () => {
    const { company } = await seedTenant()
    await finishedJob(company.id, 'export-items', await read('export-items'))
    expect(await db.tallySourceMaster.count({ where: { companyId: company.id, kind: 'stockitem' } })).toBe(3)
  })

  test('the new master job types are accepted by name; their records keep only the known fields', async () => {
    const { user, company } = await seedTenant()
    await finishedJob(company.id, 'list-companies', [{ name: COMPANY }])
    for (const type of ['export-groups', 'export-ledgers', 'export-stockgroups', 'export-units', 'export-godowns']) {
      const r = await call(createJobRoute(apiRequest('/api/import-center/tally/jobs', { body: { type, tallyCompany: COMPANY }, user })))
      expect([type, r.status]).toEqual([type, 200])
    }
    await finishedJob(company.id, 'export-units', [{ guid: 'u-1', name: 'Nos', alterId: '3', isSimple: 'Yes', decimals: '0', gstUqc: 'NOS-NUMBERS', password: 'x' } as Record<string, string>])
    const [unit] = await db.tallySourceMaster.findMany({ where: { companyId: company.id, kind: 'unit' } })
    expect(unit).toMatchObject({ name: 'Nos', alterId: 3 })
    expect(unit.data).toEqual({ isSimple: 'Yes', decimals: '0', gstUqc: 'NOS-NUMBERS' })
  })

  test('import keeps the Tally GUID of each new record in TallyMasterLink, not in the business tables', async () => {
    const { user, company } = await seedTenant()
    const records = await read('export-customers')
    const jobId = await finishedJob(company.id, 'export-customers', records)
    const r = await importBatch(user, jobId, 'customers', 'commit')
    expect(r.status).toBe(200)
    expect(r.json.data.result.counts.imported).toBe(1)
    const [customer] = await db.customer.findMany({ where: { companyId: company.id } })
    const links = await db.tallyMasterLink.findMany({ where: { companyId: company.id } })
    expect(links.map((l) => [l.kind, l.guid, l.manuflowId, l.tallyCompany])).toEqual([['customer', records[0].guid, customer.id, COMPANY]])
    // the Customer table has no Tally column
    expect(Object.keys(db.customer.fields)).not.toContain('tallyGuid')
  })

  test('a record renamed in Tally is recognised by its GUID and not imported twice', async () => {
    const { user, company } = await seedTenant()
    const records = await read('export-customers')
    await importBatch(user, await finishedJob(company.id, 'export-customers', records), 'customers', 'commit')
    const renamed = records.map((x) => ({ ...x, name: 'Renamed In Tally' }))
    const jobId = await finishedJob(company.id, 'export-customers', renamed)
    const preview = await importBatch(user, jobId, 'customers', 'preview')
    expect(preview.json.data.result.counts).toMatchObject({ total: 1, ready: 0, duplicates: 1 })
    expect(preview.json.data.result.rows[0].messages[0]).toMatch(/same Tally GUID/)
    await importBatch(user, jobId, 'customers', 'commit')
    expect(await db.customer.count({ where: { companyId: company.id } })).toBe(1)
  })

  test('a link to a record that no longer exists is ignored, and links are never removed', async () => {
    const { user, company } = await seedTenant()
    const records = await read('export-customers')
    await db.tallyMasterLink.create({ data: { companyId: company.id, tallyCompany: COMPANY, kind: 'customer', guid: records[0].guid, manuflowId: 'gone', createdAt: new Date() } })
    const jobId = await finishedJob(company.id, 'export-customers', records)
    expect((await importBatch(user, jobId, 'customers', 'preview')).json.data.result.counts.ready).toBe(1)
    await importBatch(user, jobId, 'customers', 'commit')
    expect(await db.customer.count({ where: { companyId: company.id } })).toBe(1)
    expect(await db.tallyMasterLink.count({ where: { companyId: company.id } })).toBe(1) // the old link stays (history)
  })

  test('stock items under Tally’s root group get no category; links are per company', async () => {
    const a = await seedTenant()
    const b = await seedTenant()
    const items = await read('export-items')
    await importBatch(a.user, await finishedJob(a.company.id, 'export-items', items), 'items', 'commit', { itemType: 'RAW' })
    const imported = await db.item.findMany({ where: { companyId: a.company.id } })
    expect(imported.length).toBe(3)
    expect(imported.every((i) => !i.category)).toBe(true)
    // company B imports the same Tally GUIDs as its own new records
    await importBatch(b.user, await finishedJob(b.company.id, 'export-items', items), 'items', 'commit', { itemType: 'RAW' })
    expect(await db.item.count({ where: { companyId: b.company.id } })).toBe(3)
    expect(await db.tallyMasterLink.count({ where: { companyId: a.company.id } })).toBe(3)
    expect(await db.tallyMasterLink.count({ where: { companyId: b.company.id } })).toBe(3)
  })
})
