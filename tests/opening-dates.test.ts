import { beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { db } from '@/lib/db'
import { profitAndLoss, stockValueAt, stockValueBefore } from '@/lib/accounting'
import { goLiveForOpening, openingDateFor } from '@/lib/go-live'
import { POST as commit } from '@/app/api/import-center/commit/route'
import { apiRequest, call } from './helpers/api'
import { resetDb } from './helpers/db'
import { seedTenant } from './helpers/seed'
import { verifiedTarget } from './setup/test-db-guard'

/**
 * Regression: opening stock was dated one second before go-live (23:59:59Z), which India (the server
 * runs with TZ=Asia/Kolkata, browsers are in IST) shows as the go-live day itself, and which falls after
 * the previous day's local end of day — so an "as at <previous day>" report missed it. It is now dated
 * at noon UTC of the previous day.
 */

const GO_LIVE = '2025-04-01'

function probe(tz: string) {
  const r = spawnSync(process.execPath, [path.join(import.meta.dir, 'helpers/tz-probe.ts'), GO_LIVE], {
    cwd: path.resolve(import.meta.dir, '..'),
    // The probe makes no queries; DATABASE_URL is still pinned to the verified test database.
    env: { ...process.env, TZ: tz, DATABASE_URL: verifiedTarget().url },
    encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error(`tz probe failed (${tz}): ${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').pop() as string)
}

describe('opening timestamp vs time zones', () => {
  test('noon UTC of the previous day; round-trips to the go-live date', () => {
    const opening = openingDateFor(new Date(GO_LIVE))
    expect(opening.toISOString()).toBe('2025-03-31T12:00:00.000Z')
    expect(goLiveForOpening(opening)).toBe(GO_LIVE)
    for (const [tz, day] of [['Asia/Kolkata', '31'], ['UTC', '31']]) {
      expect(opening.toLocaleDateString('en-IN', { timeZone: tz, day: '2-digit' })).toBe(day)
    }
  })

  test('Asia/Kolkata (server and browsers): shown as the previous day, inside "as at previous day", before the go-live period', () => {
    const p = probe('Asia/Kolkata')
    expect(p).toMatchObject({
      opening: '2025-03-31T12:00:00.000Z', shownOpening: '31 Mar 2025', shownGoLive: '01 Apr 2025', roundTrip: GO_LIVE,
      prevDayEnd: '2025-03-31T18:29:59.999Z', inAsAtPreviousDay: true, beforePeriodFrom: true,
    })
    // What the one-second-before timestamp did in India — the bug this guards against
    expect(p.oneSecondBefore).toEqual({ shown: '01 Apr 2025', inAsAtPreviousDay: false })
  })

  test('UTC: same calendar days and boundaries', () => {
    expect(probe('UTC')).toMatchObject({
      opening: '2025-03-31T12:00:00.000Z', shownOpening: '31 Mar 2025', shownGoLive: '01 Apr 2025', roundTrip: GO_LIVE,
      prevDayEnd: '2025-03-31T23:59:59.999Z', inAsAtPreviousDay: true, beforePeriodFrom: true,
    })
  })
})

describe('opening stock in stock values and P&L at the go-live boundary', () => {
  beforeEach(resetDb)

  test('included as at the previous day (IST and UTC day ends), part of the go-live period opening, absent the day before', async () => {
    const { company, user, warehouse } = await seedTenant()
    await db.company.update({ where: { id: company.id }, data: { goLiveDate: new Date(GO_LIVE) } })
    const item = await db.item.create({ data: { companyId: company.id, code: 'RM-1', name: 'MS Plate', uom: 'KG' } })
    const r = await call(commit(apiRequest('/api/import-center/commit', {
      user,
      body: {
        companyId: company.id, dataType: 'opening-stock', headerRow: 0, mapping: { itemCode: 0, qty: 1, rate: 2 },
        table: [{ line: 1, cells: ['Code', 'Qty', 'Rate'] }, { line: 2, cells: [item.code, '100', '120'] }],
        options: { defaultWarehouseId: warehouse.id, goLiveDate: GO_LIVE }, confirm: true,
      },
    })))
    expect(r.json.data.counts.imported).toBe(1)
    expect(r.json.data.reconciliation).toMatchObject({ goLiveDate: GO_LIVE, openingDate: '2025-03-31T12:00:00.000Z' })

    const value = 12000
    expect(await stockValueAt(company.id, new Date('2025-03-31T18:29:59.999Z'))).toBe(value) // end of 31 Mar, IST
    expect(await stockValueAt(company.id, new Date('2025-03-31T23:59:59.999Z'))).toBe(value) // end of 31 Mar, UTC
    expect(await stockValueAt(company.id, new Date('2025-03-30T18:29:59.999Z'))).toBe(0) // end of 30 Mar, IST
    expect(await stockValueBefore(company.id, new Date(GO_LIVE))).toBe(value)
    const pl = await profitAndLoss(company.id, new Date(GO_LIVE), new Date('2025-04-30T18:29:59.999Z'))
    expect(pl).toMatchObject({ openingStock: value, closingStock: value, cogs: 0 })
    expect(pl.purchases.net).toBe(0)
  })
})
