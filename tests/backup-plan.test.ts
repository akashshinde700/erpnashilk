import { beforeEach, describe, expect, test } from 'bun:test'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { NOT_BACKED_UP, PLATFORM_MODELS, backupPlan, tenantSnapshot } from '@/lib/backup-plan'
import { POST as restore } from '@/app/api/companies/[id]/restore/route'
import { GET as download } from '@/app/api/companies/[id]/backup/route'
import { apiRequest, call, ctx } from './helpers/api'
import { resetDb } from './helpers/db'
import { seedTenant } from './helpers/seed'

/**
 * Backups once silently left out returns, Cash & Bank, loans, batches and serials because the
 * table list was kept by hand. The list is now derived from the schema; these tests fail when a
 * model is added that the backup does not classify, and prove those tables survive a round trip.
 */

const models = Prisma.dmmf.datamodel.models

describe('backup plan', () => {
  test('every model is either backed up, a platform model, or explicitly excluded', () => {
    const covered = new Set(backupPlan().map((t) => t.model))
    const unclassified = models.map((m) => m.name).filter((n) => !covered.has(n) && !PLATFORM_MODELS.has(n) && !NOT_BACKED_UP.has(n))
    expect(unclassified).toEqual([])
  })

  test('parents always come before the tables that point at them', () => {
    const plan = backupPlan()
    const pos = new Map(plan.map((t, i) => [t.model, i]))
    for (const m of models) {
      if (!pos.has(m.name)) continue
      for (const f of m.fields) {
        if (f.kind === 'object' && f.relationFromFields?.length && f.type !== m.name && pos.has(f.type)) {
          expect(`${f.type} @${pos.get(f.type)! < pos.get(m.name)!}`).toBe(`${f.type} @true`)
        }
      }
    }
  })

  test('version-1 keys are unchanged, so old files still restore', () => {
    const keys = new Set(backupPlan().map((t) => t.key))
    for (const k of ['deliveries', 'stockLedger', 'stockBalances', 'bomItems', 'deliveryChallanItems', 'salesInvoiceItems', 'enquiries', 'numberSeqs']) {
      expect(keys.has(k)).toBe(true)
    }
  })

  test('scripts/daily-backup.mjs derives exactly the same plan (cron runs it on its own)', async () => {
    const script = await import('../scripts/daily-backup.mjs')
    expect(script.backupPlan(models)).toEqual(backupPlan())
  })
})

describe('backup → restore round trip', () => {
  beforeEach(async () => { await resetDb() })

  async function seedNewerTables(companyId: string, warehouseId: string) {
    const item = await db.item.create({ data: { companyId, code: 'B-1', name: 'Batch part', uom: 'NOS', batchTracked: true } as never })
    const customer = await db.customer.create({ data: { companyId, code: 'C-1', name: 'Customer' } })
    const supplier = await db.supplier.create({ data: { companyId, code: 'S-1', name: 'Supplier' } })
    const acct = await db.moneyAccount.create({ data: { companyId, type: 'BANK', name: 'Bank A' } })
    await db.accountTxn.create({ data: { companyId, number: 'TXN-1', date: new Date(), type: 'ADJUST_IN', amount: 500, toAccountId: acct.id } as never })
    await db.loan.create({ data: { companyId, name: 'Machine loan', principal: 100000, startDate: new Date() } })
    await db.itemBatch.create({ data: { companyId, itemId: item.id, warehouseId, batchNo: 'LOT-1', qty: 5 } as never })
    await db.itemSerial.create({ data: { companyId, itemId: item.id, serialNo: 'SN-1' } })
    await db.salesReturn.create({ data: { companyId, number: 'CN-1', invoiceId: 'inv-x', customerId: customer.id, warehouseId, date: new Date(), items: { create: [{ itemId: item.id, qty: 1, rate: 10 }] } } as never })
    await db.purchaseReturn.create({ data: { companyId, number: 'DN-1', invoiceId: 'bill-x', supplierId: supplier.id, warehouseId, date: new Date(), items: { create: [{ itemId: item.id, qty: 1, rate: 8 }] } } as never })
  }

  const countAll = async (companyId: string) => ({
    moneyAccounts: await db.moneyAccount.count({ where: { companyId } }),
    accountTxns: await db.accountTxn.count({ where: { companyId } }),
    loans: await db.loan.count({ where: { companyId } }),
    itemBatches: await db.itemBatch.count({ where: { companyId } }),
    itemSerials: await db.itemSerial.count({ where: { companyId } }),
    salesReturns: await db.salesReturn.count({ where: { companyId } }),
    salesReturnItems: await db.salesReturnItem.count({ where: { ret: { companyId } } }),
    purchaseReturns: await db.purchaseReturn.count({ where: { companyId } }),
    purchaseReturnItems: await db.purchaseReturnItem.count({ where: { ret: { companyId } } }),
    customers: await db.customer.count({ where: { companyId } }),
  })

  test('the download carries the newer tables and restores them as they were', async () => {
    const t = await seedTenant()
    const c = t.company.id
    await seedNewerTables(c, t.warehouse.id)
    const before = await countAll(c)

    const res = await download(apiRequest(`/api/companies/${c}/backup?companyId=${c}`, { user: t.user }), ctx({ id: c }))
    expect(res.status).toBe(200)
    const backup = await res.json()
    expect(backup.meta.version).toBe(2)
    for (const k of ['moneyAccounts', 'accountTxns', 'loans', 'itemBatches', 'itemSerials', 'salesReturns', 'salesReturnItems', 'purchaseReturns', 'purchaseReturnItems']) {
      expect(backup.meta.counts[k]).toBe(1)
    }
    expect(JSON.stringify(backup.data.users)).not.toContain('passwordHash')

    // change things after the backup, then restore
    await db.moneyAccount.deleteMany({ where: { companyId: c } })
    await db.loan.create({ data: { companyId: c, name: 'Added later', principal: 1, startDate: new Date() } })
    await db.customer.create({ data: { companyId: c, code: 'C-2', name: 'Added later' } })

    const r = await call(restore(apiRequest(`/api/companies/${c}/restore?companyId=${c}`, { user: t.user, body: { confirmName: t.company.name, backup } }), ctx({ id: c })))
    expect(r.status).toBe(200)
    expect(await countAll(c)).toEqual(before)
  })

  test('a version-1 file leaves the tables it does not carry untouched, and says so', async () => {
    const t = await seedTenant()
    const c = t.company.id
    await seedNewerTables(c, t.warehouse.id)
    const before = await countAll(c)
    const v2 = await tenantSnapshot(db, c)
    const v1Keys = ['moneyAccounts', 'accountTxns', 'loans', 'itemBatches', 'itemSerials', 'salesReturns', 'salesReturnItems', 'purchaseReturns', 'purchaseReturnItems', 'userCompanyAccesses']
    const data = Object.fromEntries(Object.entries(v2.data).filter(([k]) => !v1Keys.includes(k)))
    const v1 = { meta: { ...v2.meta, version: 1 }, data: JSON.parse(JSON.stringify(data)) }

    const r = await call(restore(apiRequest(`/api/companies/${c}/restore?companyId=${c}`, { user: t.user, body: { confirmName: t.company.name, backup: v1 } }), ctx({ id: c })))
    expect(r.status).toBe(200)
    expect(r.json.data.skipped).toContain('moneyAccounts')
    expect(r.json.message).toContain('left as they are')
    expect(await countAll(c)).toEqual(before)
  })

  test('a version-2 file missing a table, or lines without their header, is refused and nothing changes', async () => {
    const t = await seedTenant()
    const c = t.company.id
    await seedNewerTables(c, t.warehouse.id)
    const before = await countAll(c)
    const full = JSON.parse(JSON.stringify(await tenantSnapshot(db, c)))

    const noLoans = { ...full, data: { ...full.data } }
    delete noLoans.data.loans
    const r1 = await call(restore(apiRequest(`/api/companies/${c}/restore?companyId=${c}`, { user: t.user, body: { confirmName: t.company.name, backup: noLoans } }), ctx({ id: c })))
    expect(r1.status).toBe(400)
    expect(r1.json.error?.message).toContain('loans')

    const v1NoLines = { meta: { ...full.meta, version: 1 }, data: { ...full.data } }
    delete v1NoLines.data.salesReturnItems
    const r2 = await call(restore(apiRequest(`/api/companies/${c}/restore?companyId=${c}`, { user: t.user, body: { confirmName: t.company.name, backup: v1NoLines } }), ctx({ id: c })))
    expect(r2.status).toBe(400)
    expect(r2.json.error?.message).toContain('salesReturnItems')
    expect(await countAll(c)).toEqual(before)
  })
})
