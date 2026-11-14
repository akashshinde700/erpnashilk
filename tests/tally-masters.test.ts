import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { POST as createJobRoute } from '@/app/api/import-center/tally/jobs/route'
import { GET as mastersGet, POST as mastersPost } from '@/app/api/import-center/tally/master-review/route'
import { db } from '@/lib/db'
import { TALLY_JOB_TYPES } from '@/lib/tally/connector'
import { MASTER_TYPES, TALLY_DATA_TYPES } from '@/lib/tally/data-types'
import { recordJobResult } from '@/lib/tally/jobs'
import { LAYER1_SOURCE } from '@/lib/tally/layer1'
import { ledgerClassifier, unitNeedsReview } from '@/lib/tally/master-classify'
import { warehouseCode } from '@/lib/tally/master-map'
import * as connector from '../connector/tally/manuflow-tally-connector.mjs'
import { apiRequest, call, type TestUser } from './helpers/api'
import { resetDb } from './helpers/db'
import { seedTenant, seedUser } from './helpers/seed'

// Phase 1 — Tally masters: cost-centre reader (connector 0.4.0), review copy, suggested ledger meaning, godown → warehouse
// and bank / cash ledger → account links. All data here is made up; nothing contacts a real Tally.

const COMPANY = 'Demo Traders'
const wrap = (inner: string) => `<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DATA><COLLECTION>${inner}</COLLECTION></DATA></BODY></ENVELOPE>`
// Synthetic replies in the shape of TallyPrime collection exports
const REPLIES: Record<string, string> = {
  ManuFlowCompanies: wrap(`<COMPANY NAME="${COMPANY}"><NAME>${COMPANY}</NAME><GUID>c-1</GUID><STARTINGFROM>20260401</STARTINGFROM><BOOKSFROM>20260401</BOOKSFROM></COMPANY>`),
  ManuFlowGroups: wrap(
    '<GROUP NAME="Debtors"><GUID>g-1</GUID><PARENT>Current Assets</PARENT><ALTERID>5</ALTERID><RESERVEDNAME>Sundry Debtors</RESERVEDNAME></GROUP>' +
    '<GROUP NAME="Bank Accounts"><GUID>g-2</GUID><PARENT>Current Assets</PARENT><RESERVEDNAME>Bank Accounts</RESERVEDNAME></GROUP>' +
    '<GROUP NAME="Pune Banks"><GUID>g-3</GUID><PARENT>Bank Accounts</PARENT></GROUP>',
  ),
  ManuFlowCostCentres: wrap(
    '<COSTCENTRE NAME="Plant 1"><GUID>cc-1</GUID><PARENT></PARENT><ALTERID>7</ALTERID><CATEGORY>Primary Cost Category</CATEGORY></COSTCENTRE>' +
    '<COSTCENTRE NAME="Line A"><GUID>cc-2</GUID><PARENT>Plant 1</PARENT><CATEGORY>Primary Cost Category</CATEGORY></COSTCENTRE>',
  ),
  ManuFlowLedgers: wrap('<LEDGER NAME="HDFC Current"><GUID>l-1</GUID><PARENT>Pune Banks</PARENT><OPENINGBALANCE>-1500.00</OPENINGBALANCE></LEDGER>'),
  ManuFlowStockGroups: wrap('<STOCKGROUP NAME="Raw Material"><GUID>sg-1</GUID><PARENT></PARENT></STOCKGROUP>'),
  ManuFlowUnits: wrap('<UNIT NAME="Nos"><GUID>u-1</GUID><ISSIMPLEUNIT>Yes</ISSIMPLEUNIT><DECIMALPLACES>0</DECIMALPLACES></UNIT>'),
  ManuFlowGodowns: wrap('<GODOWN NAME="Main Location"><GUID>gd-1</GUID></GODOWN>'),
}

let tally: ReturnType<typeof Bun.serve>
const bodies: string[] = []
const savedFlag = process.env.TALLY_CONNECTOR_POC
beforeAll(() => {
  tally = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch(req) {
      const body = await req.text()
      bodies.push(body)
      const id = /<ID>([^<]*)<\/ID>/.exec(body)?.[1] ?? ''
      return new Response(REPLIES[id] ?? '<ENVELOPE><HEADER><STATUS>0</STATUS></HEADER></ENVELOPE>')
    },
  })
})
afterAll(() => {
  tally.stop(true)
  if (savedFlag === undefined) delete process.env.TALLY_CONNECTOR_POC
  else process.env.TALLY_CONNECTOR_POC = savedFlag
})
beforeEach(async () => {
  bodies.length = 0
  await resetDb()
  process.env.TALLY_CONNECTOR_POC = '1'
})
const tallyUrl = () => `http://127.0.0.1:${tally.port}`

// ---------------------------------------------------------------- the catalogue of 29

describe('the 29 Tally data types', () => {
  test('every one is listed exactly once with a truthful status; only the six masters can be chosen', () => {
    const others = TALLY_DATA_TYPES.filter((t) => t.status !== 'ready-for-preview')
    expect(MASTER_TYPES.length + others.length).toBe(29)
    expect(TALLY_DATA_TYPES.length).toBe(29)
    expect(new Set(TALLY_DATA_TYPES.map((t) => t.key)).size).toBe(29)
    expect(MASTER_TYPES.map((t) => t.label)).toEqual(['Ledgers', 'Ledger groups', 'Stock groups', 'Units', 'Godowns / locations', 'Cost centres'])
    // nothing claims a live verification that has not happened
    expect(TALLY_DATA_TYPES.filter((t) => t.verifiedLive)).toEqual([])
    // every master has a reader the server accepts and a Layer 1 kind; nothing else has a job
    for (const t of MASTER_TYPES) {
      expect(TALLY_JOB_TYPES as readonly string[]).toContain(t.job!)
      expect(LAYER1_SOURCE[t.job as keyof typeof LAYER1_SOURCE]?.kind).toBe(t.reviewKind as never)
    }
    for (const t of others) {
      expect([t.key, t.job]).toEqual([t.key, undefined])
      expect([t.key, t.needs.length > 0]).toEqual([t.key, true]) // says what it waits for
    }
    expect(TALLY_DATA_TYPES.filter((t) => t.group === 'Vouchers').length).toBe(13)
    expect(TALLY_DATA_TYPES.filter((t) => t.group === 'Stock').length).toBe(4)
    expect(TALLY_DATA_TYPES.filter((t) => t.group === 'Accounts').length).toBe(6)
  })
})

// ---------------------------------------------------------------- connector 0.4.0

describe('connector: cost centres and the masters capture', () => {
  test('cost centres are read with a fixed Export request that passes the read-only guard', async () => {
    const xml = connector.JOBS['export-costcentres'].request('A & B <Ltd>')
    expect(connector.isExportRequest(xml)).toBe(true)
    expect(xml).toContain('<TYPE>CostCentre</TYPE>')
    expect(xml).toContain('ISMODIFY="No"')
    expect(xml).toContain('<SVCURRENTCOMPANY>A &amp; B &lt;Ltd&gt;</SVCURRENTCOMPANY>')
    const r = await connector.runJob(tallyUrl(), { type: 'export-costcentres', company: COMPANY })
    expect(r).toEqual({ ok: true, records: [
      { guid: 'cc-1', name: 'Plant 1', alterId: '7', category: 'Primary Cost Category' },
      { guid: 'cc-2', name: 'Line A', parent: 'Plant 1', category: 'Primary Cost Category' },
    ] })
  })

  test('groups carry Tally’s reserved name, so a renamed predefined group is still recognised', async () => {
    const r = await connector.runJob(tallyUrl(), { type: 'export-groups', company: COMPANY })
    expect(r.ok).toBe(true)
    expect(r.records[0]).toMatchObject({ name: 'Debtors', reservedName: 'Sundry Debtors', parent: 'Current Assets' })
  })

  test('capture --masters saves the six reference masters (outside Git), never contacting ManuFlow', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'mf-cap-')), 'masters')
    const r = await connector.capture({ tally: tallyUrl(), out, company: COMPANY, masters: true, log: () => {} })
    expect(readdirSync(out).sort()).toEqual([
      'export-costcentres.xml', 'export-godowns.xml', 'export-groups.xml', 'export-ledgers.xml', 'export-stockgroups.xml', 'export-units.xml',
      'list-companies.xml', 'manifest.json',
    ])
    expect(r.files.map((f: { job: string; records: number }) => [f.job, f.records])).toEqual([
      ['list-companies', 1], ['export-groups', 3], ['export-ledgers', 1], ['export-stockgroups', 1], ['export-units', 1], ['export-godowns', 1], ['export-costcentres', 2],
    ])
    expect(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')).connectorVersion).toBe('0.4.0')
    for (const b of bodies) expect(connector.isExportRequest(b)).toBe(true)
    await expect(connector.capture({ tally: tallyUrl(), out: join(out, 'x'), company: COMPANY, masters: true, from: '20260401', to: '20260430' })).rejects.toThrow(/--masters/)
  })
})

// ---------------------------------------------------------------- suggested ledger meaning (pure)

describe('ledger classification from Tally’s predefined groups', () => {
  const classify = ledgerClassifier([
    { name: 'Debtors', parent: 'Current Assets', reservedName: 'Sundry Debtors' },
    { name: 'Pune Banks', parent: 'Bank Accounts' },
    { name: 'Bank Accounts', parent: 'Current Assets', reservedName: 'Bank Accounts' },
    { name: 'Office Costs', parent: 'Indirect Expenses' },
    { name: 'Loop A', parent: 'Loop B' }, { name: 'Loop B', parent: 'Loop A' },
    { name: 'My Top Group', parent: 'Primary' },
  ])
  test('predefined groups decide it, through user groups and renamed predefined groups', () => {
    expect(classify('Sundry Debtors')).toMatchObject({ category: 'customer', confidence: 'exact' })
    expect(classify('Debtors')).toMatchObject({ category: 'customer', confidence: 'exact', via: 'Debtors' }) // renamed, by reserved name
    expect(classify('Pune Banks')).toMatchObject({ category: 'bank', confidence: 'exact', path: ['Pune Banks', 'Bank Accounts'] })
    expect(classify('Office Costs')).toMatchObject({ category: 'expense', confidence: 'exact' })
    expect(classify('duties & taxes')).toMatchObject({ category: 'tax', confidence: 'exact' })
    expect(classify('Bank OD A/c')).toMatchObject({ category: 'bank', confidence: 'exact' })
    expect(classify('Cash-in-Hand')).toMatchObject({ category: 'cash', confidence: 'exact' })
  })
  test('broad groups, unknown groups, loops and top-level groups are never guessed', () => {
    expect(classify('Current Assets')).toMatchObject({ category: 'asset', confidence: 'review' })
    expect(classify('Suspense A/c')).toMatchObject({ category: 'suspense', confidence: 'review' })
    expect(classify('Not Read Group')).toMatchObject({ category: 'unknown', confidence: 'review' })
    expect(classify('Loop A')).toMatchObject({ category: 'unknown', confidence: 'review' })
    expect(classify('My Top Group')).toMatchObject({ category: 'unknown', confidence: 'review' })
    expect(classify('Primary')).toMatchObject({ category: 'unknown', confidence: 'review' })
    expect(classify(null)).toMatchObject({ category: 'unknown', confidence: 'review' })
  })
  test('compound units need review; warehouse codes made from godown names are unique', () => {
    expect(unitNeedsReview({ isSimple: 'Yes' })).toBe(false)
    expect(unitNeedsReview({ isSimple: 'No', baseUnits: 'Box', additionalUnits: 'Nos' })).toBe(true)
    expect(warehouseCode('Main Location', new Set())).toBe('MAIN-LOCATION')
    expect(warehouseCode('Main Location', new Set(['MAIN-LOCATION', 'MAIN-LOCATION-2']))).toBe('MAIN-LOCATION-3')
    expect(warehouseCode('॥', new Set())).toBe('GODOWN')
  })
})

// ---------------------------------------------------------------- through the routes

async function connectorFor(companyId: string, version = '0.4.0') {
  return db.tallyConnector.create({
    data: { id: companyId.slice(-24).padStart(24, '0'), companyId, activeFor: companyId, secretHash: 'x', pairedAt: new Date(), pairedBy: 'u', lastSeenAt: new Date(), lastTallyStatus: 'connected', version },
  })
}
/** A finished job with these records, posted the way the connector posts them (so Layer 1 staging runs too). */
async function finishedJob(companyId: string, type: string, records: Record<string, string>[]) {
  const c = (await db.tallyConnector.findUnique({ where: { activeFor: companyId } })) ?? await connectorFor(companyId)
  const id = `${type}-${Math.random().toString(16).slice(2, 10)}`
  await db.tallyJob.create({ data: { id, companyId, connectorId: c.id, type, tallyCompany: type === 'list-companies' ? null : COMPANY, status: 'running', createdBy: 'u', startedAt: new Date(), leaseUntil: new Date(Date.now() + 60_000) } })
  expect((await recordJobResult(c, { jobId: id, ok: true, records })).accepted).toBe(true)
  return id
}
/** Reads every master from the mock Tally and stages it, as a finished connector job would. */
async function stageAll(companyId: string) {
  for (const type of ['export-groups', 'export-ledgers', 'export-stockgroups', 'export-units', 'export-godowns', 'export-costcentres']) {
    const r = await connector.runJob(tallyUrl(), { type, company: COMPANY })
    expect([type, r.ok]).toEqual([type, true])
    await finishedJob(companyId, type, r.records)
  }
}
const get = (user: TestUser, query: string) => call(mastersGet(apiRequest(`/api/import-center/tally/master-review?${query}`, { user })))
const post = (user: TestUser, body: Record<string, unknown>) => call(mastersPost(apiRequest('/api/import-center/tally/master-review', { body: { tallyCompany: COMPANY, ...body }, user })))
const tc = `tallyCompany=${encodeURIComponent(COMPANY)}`

/** Rows of every business table (not Tally's own tables, not the audit log) — must not change by reading masters. */
async function businessCounts() {
  const tables = await db.$queryRawUnsafe<{ name: string }[]>(
    "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' AND table_name NOT LIKE 'Tally%' AND table_name <> 'AuditLog' ORDER BY table_name",
  )
  const out: Record<string, number> = {}
  for (const { name } of tables) out[name] = Number((await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM \`${name.replaceAll('`', '')}\``))[0].n)
  return out
}

describe('cost-centre jobs need connector 0.4.0', () => {
  test('an older connector is not asked (it would not know the request); 0.4.0 is', async () => {
    const { user, company } = await seedTenant()
    await connectorFor(company.id, '0.3.3')
    await finishedJob(company.id, 'list-companies', [{ name: COMPANY }])
    const old = await call(createJobRoute(apiRequest('/api/import-center/tally/jobs', { body: { type: 'export-costcentres', tallyCompany: COMPANY }, user })))
    expect([old.status, old.json.error?.code]).toEqual([409, 'CONNECTOR_UPDATE_NEEDED'])
    expect(await db.tallyJob.count({ where: { companyId: company.id, type: 'export-costcentres' } })).toBe(0)
    // the other masters still work with 0.3.3
    expect((await call(createJobRoute(apiRequest('/api/import-center/tally/jobs', { body: { type: 'export-godowns', tallyCompany: COMPANY }, user })))).status).toBe(200)
    await db.tallyConnector.updateMany({ where: { companyId: company.id }, data: { version: '0.4.0' } })
    expect((await call(createJobRoute(apiRequest('/api/import-center/tally/jobs', { body: { type: 'export-costcentres', tallyCompany: COMPANY }, user })))).status).toBe(200)
  })
})

describe('masters review copy', () => {
  test('reading masters stages them in Layer 1 only: no business table changes', async () => {
    const { company } = await seedTenant()
    const before = await businessCounts()
    await stageAll(company.id)
    expect(await businessCounts()).toEqual(before)
    const kinds = await db.tallySourceMaster.groupBy({ by: ['kind'], where: { companyId: company.id }, _count: { _all: true }, orderBy: { kind: 'asc' } })
    expect(kinds.map((k) => [k.kind, k._count._all])).toEqual([['costcentre', 2], ['godown', 1], ['group', 3], ['ledger', 1], ['stockgroup', 1], ['unit', 1]])
  })

  test('summary and per-kind review: suggested meaning, items using a unit / group, suggestions never linked', async () => {
    const { user, company, warehouse } = await seedTenant()
    await db.warehouse.update({ where: { id: warehouse.id }, data: { name: 'Main Location' } })
    await db.item.createMany({ data: [
      { companyId: company.id, code: 'I-1', name: 'Bolt', uom: 'NOS', category: 'Raw Material', type: 'RAW' },
      { companyId: company.id, code: 'I-2', name: 'Nut', uom: 'nos', category: 'raw material', type: 'RAW' },
    ] as never })
    await stageAll(company.id)

    const s = await get(user, tc)
    expect(s.status).toBe(200)
    expect(s.json.data.summary.map((k: { kind: string; total: number }) => [k.kind, k.total])).toEqual([
      ['group', 3], ['ledger', 1], ['stockgroup', 1], ['unit', 1], ['godown', 1], ['costcentre', 2],
    ])

    const ledgers = await get(user, `${tc}&kind=ledger`)
    expect(ledgers.json.data.rows[0]).toMatchObject({
      name: 'HDFC Current', needsReview: false, link: null,
      classification: { category: 'bank', confidence: 'exact', path: ['Pune Banks', 'Bank Accounts'] },
      data: { openingBalance: '-1500.00', openingBalancePaise: -150000 },
    })
    expect((await get(user, `${tc}&kind=unit`)).json.data.rows[0]).toMatchObject({ name: 'Nos', itemsUsing: 2, needsReview: false })
    expect((await get(user, `${tc}&kind=stockgroup`)).json.data.rows[0]).toMatchObject({ name: 'Raw Material', itemsUsing: 2 })
    const godowns = await get(user, `${tc}&kind=godown`)
    expect(godowns.json.data.rows[0]).toMatchObject({ name: 'Main Location', link: null, suggestion: { id: warehouse.id }, needsReview: true })
    expect(await db.tallyMasterLink.count({ where: { companyId: company.id } })).toBe(0) // a suggestion is not a link
    expect((await get(user, `${tc}&kind=costcentre`)).json.data.rows.map((r: { name: string; parent: string | null }) => [r.name, r.parent])).toEqual([['Line A', 'Plant 1'], ['Plant 1', null]])

    // filters and search
    expect((await get(user, `${tc}&kind=group&filter=review`)).json.data.matching).toBe(0)
    expect((await get(user, `${tc}&kind=group&q=pune`)).json.data.rows.map((r: { name: string }) => r.name)).toEqual(['Pune Banks'])
    expect((await get(user, `${tc}&kind=nonsense`)).status).toBe(400)
    expect((await get(user, 'kind=ledger')).status).toBe(400) // Tally company required
  })

  test('company isolation and permissions', async () => {
    const a = await seedTenant()
    const b = await seedTenant()
    await stageAll(a.company.id)
    const other = await get(b.user, `${tc}&kind=ledger`)
    expect(other.status).toBe(200)
    expect(other.json.data.summary.total).toBe(0)
    expect(other.json.data.rows).toEqual([])
    const viewer = await seedUser(a.company.id, 'VIEWER')
    expect((await get(viewer, tc)).status).toBe(403)
    expect((await get(null as unknown as TestUser, tc)).status).toBe(401)
    // the feature switch off → not available
    process.env.TALLY_CONNECTOR_POC = '0'
    expect((await get(a.user, tc)).status).toBe(503)
  })
})

describe('linking a godown to a warehouse', () => {
  test('to an existing warehouse: one link, audited; one-to-one; unlink', async () => {
    const { user, company, warehouse } = await seedTenant()
    await stageAll(company.id)
    const r = await post(user, { kind: 'godown', guid: 'gd-1', warehouseId: warehouse.id })
    expect(r.status).toBe(200)
    expect(r.json.data).toMatchObject({ linked: { kind: 'warehouse', id: warehouse.id }, created: false, changed: true })
    const links = await db.tallyMasterLink.findMany({ where: { companyId: company.id } })
    expect(links.map((l) => [l.kind, l.guid, l.manuflowId, l.tallyCompany])).toEqual([['warehouse', 'gd-1', warehouse.id, COMPANY]])
    expect(await db.auditLog.count({ where: { companyId: company.id, action: 'TALLY_LINK' } })).toBe(1)
    // the same again changes nothing
    expect((await post(user, { kind: 'godown', guid: 'gd-1', warehouseId: warehouse.id })).json.data.changed).toBe(false)
    expect((await get(user, `${tc}&kind=godown`)).json.data.rows[0].link).toMatchObject({ kind: 'warehouse', id: warehouse.id })

    // one-to-one: a second godown cannot take the same warehouse
    await finishedJob(company.id, 'export-godowns', [{ guid: 'gd-1', name: 'Main Location' }, { guid: 'gd-2', name: 'Second' }])
    const taken = await post(user, { kind: 'godown', guid: 'gd-2', warehouseId: warehouse.id })
    expect(taken.status).toBe(409)
    expect(taken.json.error?.message).toContain('Main Location')

    const un = await post(user, { kind: 'godown', guid: 'gd-1', unlink: true })
    expect([un.status, un.json.data.changed]).toEqual([200, true])
    expect(await db.tallyMasterLink.count({ where: { companyId: company.id } })).toBe(0)
    expect(await db.auditLog.count({ where: { companyId: company.id, action: 'TALLY_UNLINK' } })).toBe(1)
  })

  test('create a warehouse for a godown (same rules as the warehouse screen), then link it', async () => {
    const { user, company } = await seedTenant()
    await stageAll(company.id)
    const r = await post(user, { kind: 'godown', guid: 'gd-1', create: { type: 'GENERAL' } })
    expect(r.status).toBe(200)
    expect(r.json.data.created).toBe(true)
    const w = await db.warehouse.findFirstOrThrow({ where: { companyId: company.id, name: 'Main Location' } })
    expect([w.code, w.type]).toEqual(['MAIN-LOCATION', 'GENERAL'])
    expect(r.json.data.linked.id).toBe(w.id)
    expect(await db.auditLog.count({ where: { companyId: company.id, action: 'CREATE', entity: 'Warehouse', entityId: w.id } })).toBe(1)
    expect((await post(user, { kind: 'godown', guid: 'gd-1', create: { type: 'NOPE' } })).status).toBe(400)
  })

  test('refused: another company’s warehouse, a godown not read, one no longer in Tally, no warehouse rights', async () => {
    const a = await seedTenant()
    const b = await seedTenant()
    await stageAll(a.company.id)
    expect((await post(a.user, { kind: 'godown', guid: 'gd-1', warehouseId: b.warehouse.id })).status).toBe(404)
    expect((await post(a.user, { kind: 'godown', guid: 'not-read', warehouseId: a.warehouse.id })).status).toBe(404)
    expect((await post(b.user, { kind: 'godown', guid: 'gd-1', warehouseId: b.warehouse.id })).status).toBe(404) // a's copy is not b's
    await db.tallySourceMaster.updateMany({ where: { companyId: a.company.id, kind: 'godown' }, data: { missingSince: new Date() } })
    expect((await post(a.user, { kind: 'godown', guid: 'gd-1', warehouseId: a.warehouse.id })).status).toBe(409)
    const accountant = await seedUser(a.company.id, 'ACCOUNTANT')
    expect((await post(accountant, { kind: 'godown', guid: 'gd-1', warehouseId: a.warehouse.id })).status).toBe(403)
    expect((await post(a.user, { kind: 'stockgroup', guid: 'sg-1' })).status).toBe(400)
    expect(await db.tallyMasterLink.count()).toBe(0)
  })
})

describe('linking a bank / cash ledger to a Cash & Bank account', () => {
  test('a bank ledger links to a bank account only; non-bank ledgers cannot be linked', async () => {
    const { user, company } = await seedTenant()
    await stageAll(company.id)
    await finishedJob(company.id, 'export-ledgers', [
      { guid: 'l-1', name: 'HDFC Current', parent: 'Pune Banks' },
      { guid: 'l-2', name: 'Rent', parent: 'Indirect Expenses' },
      { guid: 'l-3', name: 'Odd', parent: 'Current Assets' },
    ])
    const bank = await db.moneyAccount.create({ data: { companyId: company.id, type: 'BANK', name: 'HDFC' } })
    const cash = await db.moneyAccount.create({ data: { companyId: company.id, type: 'CASH', name: 'Cash' } })
    expect((await post(user, { kind: 'ledger', guid: 'l-1', moneyAccountId: cash.id })).status).toBe(400)
    expect((await post(user, { kind: 'ledger', guid: 'l-2', moneyAccountId: bank.id })).status).toBe(400)
    expect((await post(user, { kind: 'ledger', guid: 'l-3', moneyAccountId: bank.id })).status).toBe(400) // broad group: needs review
    const ok = await post(user, { kind: 'ledger', guid: 'l-1', moneyAccountId: bank.id })
    expect(ok.status).toBe(200)
    expect((await get(user, `${tc}&kind=ledger&filter=linked`)).json.data.rows.map((r: { name: string; link: { label: string } }) => [r.name, r.link.label])).toEqual([['HDFC Current', 'Bank account — HDFC']])
    expect((await get(user, `${tc}&kind=ledger&filter=review`)).json.data.rows.map((r: { name: string }) => r.name)).toEqual(['Odd'])
    // the account and its balance are untouched
    expect(await db.moneyAccount.findUniqueOrThrow({ where: { id: bank.id } })).toMatchObject({ openingBalance: 0, name: 'HDFC' })
    expect(await db.accountTxn.count({ where: { companyId: company.id } })).toBe(0)
    // a role without Cash & Bank rights cannot link ledgers
    const store = await seedUser(company.id, 'STORE_MANAGER')
    expect((await post(store, { kind: 'ledger', guid: 'l-1', unlink: true })).status).toBe(403)
  })
})
