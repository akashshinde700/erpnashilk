import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { GET as periodRoute } from '@/app/api/import-center/tally/period/route'
import { db } from '@/lib/db'
import {
  PeriodError, financialYearOf, financialYears, isDate, monthRanges, resolvePeriod, toTallyDate, todayInIndia, type TallyCompanyDates,
} from '@/lib/tally/period'
import { apiRequest, call, type TestUser } from './helpers/api'
import { resetDb } from './helpers/db'
import { seedTenant, seedUser } from './helpers/seed'

// Phase D: periods across financial years, worked out from Tally's own company dates. Pure rules first, then the route.

const APRIL = { month: 4, day: 1 }
const co: TallyCompanyDates = { booksFrom: '2024-04-01', startingFrom: '2026-04-01' }
const resolve = (input: Parameters<typeof resolvePeriod>[0], company = co, today = '2026-11-03') => resolvePeriod(input, company, today)
const refused = (input: Parameters<typeof resolvePeriod>[0], company = co, today = '2026-11-03') => {
  try { resolvePeriod(input, company, today) } catch (e) { if (e instanceof PeriodError) return e.message; throw e }
  throw new Error('expected the period to be refused')
}

describe('dates and financial years', () => {
  test('only real calendar dates are accepted', () => {
    for (const ok of ['2026-04-01', '2024-02-29', '2026-12-31']) expect([ok, isDate(ok)]).toEqual([ok, true])
    for (const bad of ['2026-02-30', '2025-02-29', '2026-13-01', '2026-4-1', '20260401', '', null, 20260401, '1800-01-01']) expect([bad, isDate(bad)]).toEqual([bad, false])
    expect(toTallyDate('2026-04-01')).toBe('20260401')
  })

  test('the financial year containing a date, at both edges', () => {
    expect(financialYearOf('2026-11-03', APRIL)).toEqual({ from: '2026-04-01', to: '2027-03-31', label: 'FY 2026-27' })
    expect(financialYearOf('2026-04-01', APRIL)).toEqual({ from: '2026-04-01', to: '2027-03-31', label: 'FY 2026-27' })
    expect(financialYearOf('2026-03-31', APRIL)).toEqual({ from: '2025-04-01', to: '2026-03-31', label: 'FY 2025-26' })
    expect(financialYearOf('2026-11-03', { month: 1, day: 1 })).toEqual({ from: '2026-01-01', to: '2026-12-31', label: 'FY 2026' })
    expect(financialYearOf('2028-03-31', APRIL).to).toBe('2028-03-31') // leap year: the year still ends on 31 March
  })

  test('a range is split into its financial years and months, clipped at both ends', () => {
    expect(financialYears({ from: '2024-08-15', to: '2026-11-03' }, APRIL)).toEqual([
      { from: '2024-08-15', to: '2025-03-31', label: 'FY 2024-25' },
      { from: '2025-04-01', to: '2026-03-31', label: 'FY 2025-26' },
      { from: '2026-04-01', to: '2026-11-03', label: 'FY 2026-27' },
    ])
    expect(monthRanges({ from: '2024-01-15', to: '2024-03-10' })).toEqual([
      { from: '2024-01-15', to: '2024-01-31' }, { from: '2024-02-01', to: '2024-02-29' }, { from: '2024-03-01', to: '2024-03-10' },
    ])
    expect(monthRanges({ from: '2025-12-01', to: '2026-01-31' }).length).toBe(2) // across a calendar year
  })
})

describe('periods', () => {
  test('current financial year', () => {
    const p = resolve({ kind: 'current-fy' })
    expect([p.from, p.to, p.label, p.months]).toEqual(['2026-04-01', '2027-03-31', 'Current financial year (FY 2026-27)', 12])
    expect(p.notes).toEqual([])
  })

  test('last financial year, and none when the books begin after it', () => {
    const p = resolve({ kind: 'last-fy' })
    expect([p.from, p.to, p.label]).toEqual(['2025-04-01', '2026-03-31', 'Last financial year (FY 2025-26)'])
    expect(refused({ kind: 'last-fy' }, { booksFrom: '2026-04-01', startingFrom: '2026-04-01' })).toMatch(/no previous financial year/)
  })

  test('books that begin mid-year shorten the first year', () => {
    const p = resolve({ kind: 'current-fy' }, { booksFrom: '2026-08-15', startingFrom: '2026-04-01' })
    expect([p.from, p.to]).toEqual(['2026-08-15', '2027-03-31'])
  })

  test('all data covers every financial year from the start of the books', () => {
    const p = resolve({ kind: 'all' })
    expect([p.from, p.to, p.months]).toEqual(['2024-04-01', '2027-03-31', 36])
    expect(p.financialYears.map((y) => y.label)).toEqual(['FY 2024-25', 'FY 2025-26', 'FY 2026-27'])
    // all data is never guessed: without the start of the books it is refused
    expect(refused({ kind: 'all' }, { booksFrom: null, startingFrom: '2026-04-01' })).toMatch(/cannot be worked out/)
  })

  test('a company whose financial year runs January to December', () => {
    const p = resolve({ kind: 'all' }, { booksFrom: '2025-01-01', startingFrom: '2026-01-01' })
    expect(p.financialYears.map((y) => [y.from, y.to])).toEqual([['2025-01-01', '2025-12-31'], ['2026-01-01', '2026-12-31']])
  })

  test('financial year start not reported: 1 April assumed, and the period says so', () => {
    const p = resolve({ kind: 'current-fy' }, { booksFrom: '2024-04-01', startingFrom: null })
    expect([p.from, p.to]).toEqual(['2026-04-01', '2027-03-31'])
    expect(p.notes.join(' ')).toMatch(/1 April is assumed/)
  })

  test('custom range: checked, and moved to the start of the books when it begins earlier', () => {
    const p = resolve({ kind: 'custom', from: '2025-10-01', to: '2025-10-31' })
    expect([p.from, p.to, p.months, p.financialYears.length]).toEqual(['2025-10-01', '2025-10-31', 1, 1])
    const early = resolve({ kind: 'custom', from: '2023-01-01', to: '2024-06-30' })
    expect([early.from, early.notes.join(' ')]).toEqual(['2024-04-01', expect.stringMatching(/the range starts there/)])
    expect(refused({ kind: 'custom', from: '2025-10-31', to: '2025-10-01' })).toMatch(/on or before/)
    expect(refused({ kind: 'custom', from: '2025-02-30', to: '2025-03-31' })).toMatch(/both dates/)
    expect(refused({ kind: 'custom', from: '2026-04-01', to: '2027-04-01' })).toMatch(/at the latest/)
    expect(refused({ kind: 'custom', from: '2023-01-01', to: '2023-12-31' })).toMatch(/whole range is before/)
    expect(refused({ kind: 'yesterday' })).toBe('Choose a period')
  })

  test('today is taken in Indian time', () => {
    // 2026-03-31 20:00 UTC is already 1 April in India
    expect(todayInIndia(new Date('2026-03-31T20:00:00Z'))).toBe('2026-04-01')
  })
})

// ---------------------------------------------------------------- route

const savedFlag = process.env.TALLY_CONNECTOR_POC
afterAll(() => {
  if (savedFlag === undefined) delete process.env.TALLY_CONNECTOR_POC
  else process.env.TALLY_CONNECTOR_POC = savedFlag
})

/** A finished company list from Tally, as the connector would leave it. */
async function companyList(companyId: string, records: Record<string, string>[]) {
  const c = await db.tallyConnector.create({ data: { id: companyId.slice(0, 24).padEnd(24, '0'), companyId, activeFor: companyId, secretHash: 'x', pairedAt: new Date(), pairedBy: 'u' } })
  const j = await db.tallyJob.create({ data: { id: `list-${companyId}`.slice(0, 40), companyId, connectorId: c.id, type: 'list-companies', status: 'done', createdBy: 'u', recordCount: records.length } })
  await db.tallyJobChunk.create({ data: { jobId: j.id, companyId, seq: 0, records } })
}

const periods = (user: TestUser, query: string) => call(periodRoute(apiRequest(`/api/import-center/tally/period?${query}`, { user })))

describe('GET /api/import-center/tally/period', () => {
  beforeEach(async () => {
    await resetDb()
    process.env.TALLY_CONNECTOR_POC = '1'
  })

  test('the three periods of a company from the latest Tally list', async () => {
    const { user, company } = await seedTenant()
    await companyList(company.id, [{ name: 'Shree & Sons', booksFrom: '2024-04-01', startingFrom: '2026-04-01' }, { name: 'New Co', booksFrom: '2026-10-01', startingFrom: '2026-04-01' }])
    const r = await periods(user, `tallyCompany=${encodeURIComponent('Shree & Sons')}`)
    expect(r.status).toBe(200)
    const today = r.json.data.today as string
    const cur = financialYearOf(today, APRIL)
    expect(r.json.data.options['current-fy'].period).toMatchObject({ from: cur.from, to: cur.to })
    expect(r.json.data.options.all.period).toMatchObject({ from: '2024-04-01', to: cur.to })
    expect(r.json.data.options.all.period.financialYears[0].from).toBe('2024-04-01')
    // a company whose books began this year has no last financial year
    const n = await periods(user, 'tallyCompany=New%20Co')
    expect(n.json.data.options['last-fy']).toEqual({ ok: false, message: expect.stringMatching(/no previous financial year/) })
  })

  test('custom ranges are checked by the server', async () => {
    const { user, company } = await seedTenant()
    await companyList(company.id, [{ name: 'Shree & Sons', booksFrom: '2024-04-01', startingFrom: '2026-04-01' }])
    const good = await periods(user, 'tallyCompany=Shree%20%26%20Sons&kind=custom&from=2025-10-01&to=2025-10-31')
    expect([good.status, good.json.data.months]).toEqual([200, 1])
    const bad = await periods(user, 'tallyCompany=Shree%20%26%20Sons&kind=custom&from=2025-10-31&to=2025-10-01')
    expect([bad.status, bad.json.error?.code]).toEqual([400, 'INVALID_PERIOD'])
  })

  test('only companies from the latest Tally list; other tenants, viewers and a disabled connector are refused', async () => {
    const { user, company } = await seedTenant()
    await companyList(company.id, [{ name: 'Shree & Sons', booksFrom: '2024-04-01', startingFrom: '2026-04-01' }])
    expect((await periods(user, 'tallyCompany=Unknown')).json.error?.code).toBe('TALLY_COMPANY_UNKNOWN')
    const other = await seedTenant()
    expect((await periods(other.user, 'tallyCompany=Shree%20%26%20Sons')).json.error?.code).toBe('TALLY_COMPANY_UNKNOWN')
    expect((await periods(other.user, `tallyCompany=Shree%20%26%20Sons&companyId=${company.id}`)).status).toBe(403)
    const viewer = await seedUser(company.id, 'VIEWER')
    expect((await periods(viewer, 'tallyCompany=Shree%20%26%20Sons')).status).toBe(403)
    delete process.env.TALLY_CONNECTOR_POC
    expect((await periods(user, 'tallyCompany=Shree%20%26%20Sons')).status).toBe(503)
  })
})
