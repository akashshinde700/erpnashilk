import { beforeEach, describe, expect, test } from 'bun:test'
import { db } from '@/lib/db'
import { postStock } from '@/lib/erp-helpers'
import { profitAndLoss } from '@/lib/accounting'
import { GET as getGoLive, PUT as putGoLive } from '@/app/api/import-center/go-live/route'
import { POST as preview } from '@/app/api/import-center/preview/route'
import { POST as commit } from '@/app/api/import-center/commit/route'
import { GET as reconcile } from '@/app/api/import-center/opening-stock/reconcile/route'
import { GET as history } from '@/app/api/import-center/history/route'
import { POST as createItem } from '@/app/api/items/route'
import { importDate } from '@/lib/import/apply-mapping'
import { apiRequest, call, type TestUser } from './helpers/api'
import { resetDb } from './helpers/db'
import { seedTenant, seedUser, seedWarehouse } from './helpers/seed'

beforeEach(resetDb)

const GO_LIVE = '2025-04-01'
const table = (rows: string[][]) => rows.map((cells, i) => ({ line: i + 1, cells }))
const post = (handler: (r: Request) => Promise<Response>, user: TestUser, body: Record<string, unknown>) =>
  call(handler(apiRequest('/api/import-center/x', { user, body })))
type Row = { line: number; status: string; messages: string[]; warnings: string[]; values: Record<string, string>; extra?: Record<string, unknown> }

async function stockSetup() {
  const t = await seedTenant() // warehouse MAIN
  const fg = await seedWarehouse(t.company.id, 'FG', 'FG')
  const mk = (code: string, name: string, extra: Record<string, unknown> = {}) =>
    db.item.create({ data: { companyId: t.company.id, code, name, uom: 'KG', ...extra } as never })
  const items = {
    steel: await mk('RM-1', 'MS Plate 10mm'),
    motor: await mk('FG-1', 'Motor 5HP', { uom: 'NOS', type: 'FINISHED' }),
    resin: await mk('BT-1', 'Epoxy Resin', { batchTracked: true }),
    drill: await mk('SR-1', 'Drill Machine', { uom: 'NOS', trackSerial: true }),
    labour: await mk('SV-1', 'Machining Labour', { uom: 'HRS', type: 'SERVICE' }),
  }
  await db.company.update({ where: { id: t.company.id }, data: { goLiveDate: new Date(GO_LIVE) } })
  return { ...t, fg, items }
}

describe('go-live (cutover) date', () => {
  test('set, read back, validated, admin only, locked after an opening-stock import', async () => {
    const { company, user, warehouse } = await seedTenant()
    expect((await call(getGoLive(apiRequest('/api/import-center/go-live', { user })))).json.data).toMatchObject({ goLiveDate: null, locked: false })
    for (const bad of ['01-04-2025', '2025-02-30', '1999-04-01', '']) {
      expect((await call(putGoLive(apiRequest('/api/import-center/go-live', { method: 'PUT', user, body: { goLiveDate: bad } })))).status).toBe(400)
    }
    const set = await call(putGoLive(apiRequest('/api/import-center/go-live', { method: 'PUT', user, body: { goLiveDate: GO_LIVE } })))
    expect(set.json.data).toMatchObject({ goLiveDate: GO_LIVE, locked: false, openingDate: '2025-03-31T12:00:00.000Z' })
    expect(await db.auditLog.count({ where: { companyId: company.id, action: 'CONFIG' } })).toBe(1)
    const store = await seedUser(company.id, 'STORE_MANAGER')
    expect((await call(putGoLive(apiRequest('/api/import-center/go-live', { method: 'PUT', user: store, body: { goLiveDate: '2025-05-01' } })))).status).toBe(403)

    const item = await db.item.create({ data: { companyId: company.id, code: 'A1', name: 'Bolt', uom: 'NOS' } })
    const r = await post(commit, user, {
      companyId: company.id, dataType: 'opening-stock', table: table([['Item Code', 'Qty', 'Rate'], [item.code, '10', '2']]), headerRow: 0,
      mapping: { itemCode: 0, qty: 1, rate: 2 }, options: { defaultWarehouseId: warehouse.id, goLiveDate: GO_LIVE }, confirm: true,
    })
    expect(r.json.data.counts.imported).toBe(1)
    const locked = await call(putGoLive(apiRequest('/api/import-center/go-live', { method: 'PUT', user, body: { goLiveDate: '2025-05-01' } })))
    expect(locked.status).toBe(409)
    expect((await call(putGoLive(apiRequest('/api/import-center/go-live', { method: 'PUT', user, body: { goLiveDate: GO_LIVE } })))).status).toBe(200)
  })

  test('opening figures cannot be previewed or imported without a go-live date', async () => {
    const { company, user, warehouse } = await seedTenant()
    const body = { companyId: company.id, dataType: 'opening-stock', table: table([['Item Code', 'Qty', 'Rate'], ['A1', '1', '1']]), headerRow: 0, mapping: { itemCode: 0, qty: 1, rate: 2 }, options: { defaultWarehouseId: warehouse.id } }
    expect((await post(preview, user, body)).json.error?.message).toContain('Set the go-live date')
    expect((await post(commit, user, { ...body, confirm: true })).json.error?.message).toContain('Set the go-live date')
  })

  test('dates in import files', () => {
    expect(importDate('2027-01-31')).toBe('2027-01-31')
    expect(importDate('31-01-2027')).toBe('2027-01-31')
    expect(importDate('31/01/2027')).toBe('2027-01-31')
    expect(importDate('1-Apr-27')).toBe('2027-04-01')
    expect(importDate('01-April-2027')).toBe('2027-04-01')
    for (const bad of ['1/4/27', '2027-02-30', '31-13-2027', 'soon']) expect(importDate(bad)).toBeNull()
  })
})

describe('opening stock import', () => {
  test('Tally stock summary → preview (no writes) → confirmed import → ledger, balances, batches, reconciliation, history', async () => {
    const { company, user, warehouse, fg, items } = await stockSetup()
    const file = table([
      ['Acme Precision — Stock Summary'],
      ['Particulars', 'Godown', 'Quantity', 'Rate', 'Value', 'Batch', 'Expiry'],
      ['MS Plate 10mm', 'MAIN', '100.00 Kgs', '120.00/Kgs', '12,000.00', '', ''],
      ['Motor 5HP', 'fg store', '4 Nos', '', '38,000.00', '', ''],
      ['Epoxy Resin', 'MAIN', '20 Kgs', '300', '6000', 'LOT-9', '31-01-2027'],
      ['Epoxy Resin', 'FG', '5 Kgs', '300', '1500', 'LOT-9', '31-01-2027'],
    ])
    const body = {
      companyId: company.id, dataType: 'opening-stock', source: 'TALLY', fileName: 'stock.xlsx', table: file, headerRow: 1,
      mapping: { itemName: 0, warehouse: 1, qty: 2, rate: 3, value: 4, batchNo: 5, expiryDate: 6 },
    }
    const pv = await post(preview, user, body)
    expect(pv.status).toBe(200)
    expect(pv.json.data.counts).toMatchObject({ total: 4, ready: 4, errors: 0 })
    const motor = (pv.json.data.rows as Row[])[1]
    expect(motor.extra).toMatchObject({ item: 'FG-1 Motor 5HP', warehouse: 'FG', qty: 4, rate: 9500, value: 38000 })
    expect(await db.stockLedger.count()).toBe(0)
    expect(await db.stockBalance.count()).toBe(0)
    expect(await db.auditLog.count()).toBe(0)

    // Explicit confirmation of the go-live date is required
    expect((await post(commit, user, { ...body, confirm: true })).json.error?.message).toContain(`Confirm the go-live date ${GO_LIVE}`)
    expect((await post(commit, user, { ...body, confirm: true, options: { goLiveDate: '2025-05-01' } })).status).toBe(400)
    const done = await post(commit, user, { ...body, confirm: true, options: { goLiveDate: GO_LIVE } })
    expect(done.status).toBe(200)
    expect(done.json.data.counts).toMatchObject({ imported: 4, failed: 0 })

    const ledger = await db.stockLedger.findMany({ where: { companyId: company.id }, orderBy: { qtyIn: 'desc' } })
    expect(ledger).toHaveLength(4)
    for (const l of ledger) {
      expect(l).toMatchObject({ type: 'OPENING', refType: 'OPENING' })
      expect(l.date.toISOString()).toBe('2025-03-31T12:00:00.000Z') // noon UTC of the day before go-live — never "now"
      expect(l.refNumber).toMatch(/^OSI-\d{14}-[0-9A-F]{6}$/)
    }
    expect(await db.stockBalance.findFirstOrThrow({ where: { itemId: items.steel.id, warehouseId: warehouse.id } })).toMatchObject({ qty: 100, avgRate: 120 })
    expect(await db.stockBalance.findFirstOrThrow({ where: { itemId: items.motor.id, warehouseId: fg.id } })).toMatchObject({ qty: 4, avgRate: 9500 })
    const batches = await db.itemBatch.findMany({ where: { itemId: items.resin.id }, orderBy: { qty: 'desc' } })
    expect(batches.map((b) => [b.batchNo, b.qty, b.expiryDate?.toISOString().slice(0, 10)])).toEqual([['LOT-9', 20, '2027-01-31'], ['LOT-9', 5, '2027-01-31']])

    const recon = done.json.data.reconciliation
    expect(recon.totals).toEqual({ sourceQty: 129, sourceValue: 57500, postedQty: 129, postedValue: 57500, qtyDiff: 0, valueDiff: 0 })
    expect(recon.lines).toHaveLength(4)
    expect(recon.goLiveDate).toBe(GO_LIVE)

    // Accounting: the imported stock is the opening stock of the first period, not a purchase or profit
    const pl = await profitAndLoss(company.id, new Date(GO_LIVE), new Date())
    expect(pl.openingStock).toBe(57500)
    expect(pl.purchases.net).toBe(0)
    expect(pl.cogs).toBe(0)

    const h = await call(history(apiRequest('/api/import-center/history', { user })))
    const entry = h.json.data.items[0]
    expect(entry).toMatchObject({ entity: 'OPENING_STOCK' })
    expect(entry.details).toContain(`Reference ${recon.ref} · go-live ${GO_LIVE} · source qty 129, value 57500 · posted qty 129, value 57500`)
    const again = await call(reconcile(apiRequest(`/api/import-center/opening-stock/reconcile?ref=${recon.ref}`, { user })))
    expect(again.json.data.reconciliation.totals).toMatchObject({ postedQty: 129, postedValue: 57500 })
    expect(again.json.data.history.details).toContain(recon.ref)

    // Importing the same file again creates nothing
    const second = await post(commit, user, { ...body, confirm: true, options: { goLiveDate: GO_LIVE } })
    expect(second.json.data.counts).toMatchObject({ imported: 0, duplicates: 4 })
    expect(await db.stockLedger.count({ where: { companyId: company.id } })).toBe(4)
  })

  test('nothing is assumed: missing / inconsistent quantities, values, units, warehouses, batches and item kinds are row errors', async () => {
    const { company, user, warehouse, items } = await stockSetup()
    const file = table([
      ['Item Code', 'Item Name', 'Warehouse', 'Qty', 'Rate', 'Value', 'Batch'],
      ['RM-1', '', '', '10', '', '', ''], // no rate or value
      ['RM-1', '', 'NOWHERE', '10', '5', '', ''], // unknown warehouse
      ['RM-1', '', '', '10 Nos', '5', '', ''], // wrong unit
      ['RM-1', '', '', '10', '5', '60', ''], // value ≠ qty × rate
      ['RM-1', '', '', '-3', '5', '', ''], // negative
      ['RM-1', '', '', '0', '5', '', ''], // zero → skipped
      ['BT-1', '', '', '5', '5', '', ''], // batch-tracked without batch
      ['SR-1', '', '', '1', '5', '', ''], // serial-tracked
      ['SV-1', '', '', '1', '5', '', ''], // service
      ['XX-9', '', '', '1', '5', '', ''], // unknown item
      ['RM-1', 'Something else', '', '1', '5', '', ''], // code / name disagree
      ['', 'MS Plate 10mm', '', '7', '5', '', ''], // valid (by name)
      ['RM-1', '', 'MAIN', '7', '5', '', ''], // same item + warehouse as the row above
      ['FG-1', '', '', 'ten', '5', '', ''], // not a number
    ])
    const body = { companyId: company.id, dataType: 'opening-stock', table: file, headerRow: 0, mapping: { itemCode: 0, itemName: 1, warehouse: 2, qty: 3, rate: 4, value: 5, batchNo: 6 }, options: { defaultWarehouseId: warehouse.id } }
    const rows = (await post(preview, user, body)).json.data.rows as Row[]
    const msg = (line: number) => [rows.find((r) => r.line === line)!.status, rows.find((r) => r.line === line)!.messages.join(' ')]
    expect(msg(2)).toEqual(['error', 'No rate or value — the stock cannot be valued'])
    expect(msg(3)[1]).toContain('No warehouse "NOWHERE"')
    expect(msg(4)[1]).toContain('kept in KG')
    expect(msg(5)[1]).toContain('does not match quantity × rate')
    expect(msg(6)[1]).toContain('Negative quantity')
    expect(msg(7)).toEqual(['duplicate', 'Zero quantity — nothing to import'])
    expect(msg(8)[1]).toContain('batch number is required')
    expect(msg(9)[1]).toContain('serial-tracked')
    expect(msg(10)[1]).toContain('service')
    expect(msg(11)[1]).toContain('No item with code XX-9')
    expect(msg(12)[1]).toContain('but the file says')
    expect(msg(13)[0]).toBe('ready')
    expect(msg(14)[1]).toContain('already on row 13')
    expect(msg(15)[1]).toContain('not a number')
    // Mapping-level rules
    const noWh = await post(preview, user, { ...body, mapping: { itemCode: 0, qty: 3, rate: 4 }, options: {} })
    expect(noWh.json.error?.message).toContain('default warehouse')
    const noVal = await post(preview, user, { ...body, mapping: { itemCode: 0, qty: 3 } })
    expect(noVal.json.error?.message).toContain('Rate or value')
    expect(items.steel.id).toBeTruthy()
  })

  test('existing opening stock is a duplicate; movements before go-live block it; movements after go-live warn', async () => {
    const { company, user, warehouse, fg, items } = await stockSetup()
    // Opening stock from the item form → duplicate for that item + warehouse
    await call(createItem(apiRequest('/api/items', { user, body: { companyId: company.id, name: 'Gear Box', type: 'FINISHED', openingQty: 3, openingRate: 10, openingWarehouseId: warehouse.id } })))
    // A GRN-style receipt dated before go-live, and one after
    await db.$transaction((tx) => postStock(tx as never, { companyId: company.id, itemId: items.steel.id, warehouseId: warehouse.id, type: 'GRN_IN', qtyIn: 5, rate: 100, date: new Date('2025-03-15') }))
    await db.$transaction((tx) => postStock(tx as never, { companyId: company.id, itemId: items.motor.id, warehouseId: fg.id, type: 'GRN_IN', qtyIn: 2, rate: 9000, date: new Date('2025-05-15') }))
    const file = table([['Item Name', 'Warehouse', 'Qty', 'Rate'], ['Gear Box', 'MAIN', '3', '10'], ['MS Plate 10mm', 'MAIN', '10', '100'], ['Motor 5HP', 'FG', '4', '9500']])
    const body = { companyId: company.id, dataType: 'opening-stock', table: file, headerRow: 0, mapping: { itemName: 0, warehouse: 1, qty: 2, rate: 3 } }
    const rows = (await post(preview, user, body)).json.data.rows as Row[]
    expect(rows[0]).toMatchObject({ status: 'duplicate' })
    expect(rows[1].status).toBe('error')
    expect(rows[1].messages[0]).toContain('dated before the go-live date')
    expect(rows[2].status).toBe('ready')
    expect(rows[2].warnings[0]).toContain('after go-live already recorded')
    const done = await post(commit, user, { ...body, confirm: true, options: { goLiveDate: GO_LIVE } })
    expect(done.json.data.counts).toMatchObject({ imported: 1, duplicates: 1, errors: 1 })
    expect(await db.stockBalance.findFirstOrThrow({ where: { itemId: items.motor.id, warehouseId: fg.id } })).toMatchObject({ qty: 6 })
  })

  test('a go-live date in the future cannot be imported against', async () => {
    const { company, user, warehouse } = await stockSetup()
    await db.company.update({ where: { id: company.id }, data: { goLiveDate: new Date('2099-04-01') } })
    const body = { companyId: company.id, dataType: 'opening-stock', table: table([['Item Code', 'Qty', 'Rate'], ['RM-1', '1', '1']]), headerRow: 0, mapping: { itemCode: 0, qty: 1, rate: 2 }, options: { defaultWarehouseId: warehouse.id, goLiveDate: '2099-04-01' } }
    expect((await post(preview, user, body)).status).toBe(200) // checking is fine
    expect((await post(commit, user, { ...body, confirm: true })).json.error?.message).toContain('in the future')
    expect(await db.stockLedger.count()).toBe(0)
  })

  test('company isolation, permissions and partial failures', async () => {
    const a = await stockSetup()
    const b = await seedTenant()
    const bWh = await seedWarehouse(b.company.id, 'B-ONLY')
    const base = { companyId: a.company.id, dataType: 'opening-stock', headerRow: 0, mapping: { itemCode: 0, warehouse: 1, qty: 2, rate: 3 } }
    // Another company's warehouse: not usable by code, nor as the default
    const pv = await post(preview, a.user, { ...base, table: table([['Code', 'Warehouse', 'Qty', 'Rate'], ['RM-1', 'B-ONLY', '1', '1']]) })
    expect((pv.json.data.rows as Row[])[0].messages[0]).toContain('No warehouse "B-ONLY"')
    const def = await post(preview, a.user, { ...base, mapping: { itemCode: 0, qty: 2, rate: 3 }, options: { defaultWarehouseId: bWh.id }, table: table([['Code', 'W', 'Qty', 'Rate'], ['RM-1', '', '1', '1']]) })
    expect(def.json.error?.message).toContain('does not belong to this company')
    // Other company's user, and roles without Import Center access
    expect((await post(commit, b.user, { ...base, table: table([['Code', 'W', 'Qty', 'Rate'], ['RM-1', 'MAIN', '1', '1']]), options: { goLiveDate: GO_LIVE }, confirm: true })).status).toBe(403)
    const store = await seedUser(a.company.id, 'STORE_MANAGER')
    expect((await post(preview, store, { ...base, table: table([['Code', 'W', 'Qty', 'Rate'], ['RM-1', 'MAIN', '1', '1']]) })).status).toBe(403)

    // A database failure on one row: that row fails, the others post, reconciliation shows the gap
    await db.$executeRawUnsafe('ALTER TABLE StockLedger ADD CONSTRAINT test_fail_opening_import CHECK (qtyIn <> 7777)')
    try {
      const r = await post(commit, a.user, {
        ...base, options: { goLiveDate: GO_LIVE }, confirm: true,
        table: table([['Code', 'W', 'Qty', 'Rate'], ['RM-1', 'MAIN', '10', '2'], ['FG-1', 'MAIN', '7777', '1'], ['BT-X', 'MAIN', '1', '1']]),
      })
      expect(r.json.data.counts).toMatchObject({ imported: 1, failed: 1, errors: 1 })
      expect((r.json.data.rows as Row[])[1]).toMatchObject({ status: 'failed', messages: ['Failed to post opening stock'] })
      expect(JSON.stringify(r.json)).not.toContain('test_fail_opening_import')
      expect(r.json.data.reconciliation.totals).toMatchObject({ sourceQty: 7787, postedQty: 10, qtyDiff: -7777, valueDiff: -7777 })
      expect(await db.stockBalance.count({ where: { itemId: a.items.motor.id } })).toBe(0)
    } finally {
      await db.$executeRawUnsafe('ALTER TABLE StockLedger DROP CHECK test_fail_opening_import')
    }
  })
})

describe('party opening balances (check and reconcile only)', () => {
  async function balanceSetup() {
    const t = await seedTenant()
    await db.company.update({ where: { id: t.company.id }, data: { goLiveDate: new Date(GO_LIVE) } })
    const cid = t.company.id
    await db.customer.createMany({ data: [
      { companyId: cid, code: 'C-0001', name: 'Shree Traders' },
      { companyId: cid, code: 'C-0002', name: 'Patel & Co', openingBalance: 500 },
      { companyId: cid, code: 'C-0003', name: 'Advance Co' },
      { companyId: cid, code: 'C-0004', name: 'Gst Match Pvt Ltd', gstin: '27ABCDE1234F1Z5' },
    ] })
    await db.supplier.create({ data: { companyId: cid, code: 'S-0001', name: 'Tata Steel' } })
    return t
  }

  test('Dr / Cr balances are matched to parties, signed, totalled and flagged — and nothing is written', async () => {
    const { company, user } = await balanceSetup()
    const body = {
      companyId: company.id, dataType: 'opening-balances', headerRow: 0, mapping: { name: 0, gstin: 1, balance: 2 }, options: { partyKind: 'customer' },
      table: table([
        ['Particulars', 'GSTIN', 'Closing Balance'],
        ['Shree Traders', '', '12,500.00 Dr'],
        ['Patel & Co', '', '500.00 Dr'],
        ['Advance Co', '', '300.00 Cr'],
        ['GST Match', '27ABCDE1234F1Z5', '1,000 Dr'],
        ['Ghost Ltd', '', '100 Dr'],
        ['Zero Co', '', '0'],
        ['Plain Co', '', '250'],
      ]),
    }
    const before = await db.customer.findMany({ orderBy: { code: 'asc' }, select: { openingBalance: true } })
    const pv = await post(preview, user, body)
    expect(pv.status).toBe(200)
    const rows = pv.json.data.rows as Row[]
    const st = rows.map((r) => r.status)
    expect(st).toEqual(['ready', 'duplicate', 'ready', 'ready', 'error', 'error', 'error'])
    expect(rows[0].extra).toMatchObject({ party: 'C-0001 Shree Traders', side: 'DR', amount: 12500, signed: 12500 })
    expect(rows[1].messages[0]).toContain('already has this opening balance')
    expect(rows[2].extra).toMatchObject({ side: 'CR', signed: -300 })
    expect(rows[2].warnings.join(' ')).toContain('advance received')
    expect(rows[3].warnings[0]).toContain('Matched by GSTIN to C-0004')
    expect(rows[4].messages[0]).toContain('No customer Ghost Ltd')
    expect(rows[5].messages[0]).toContain('No customer Zero Co') // not a party, so not a skip
    expect(rows[6].messages[0]).toContain('No Dr / Cr marker')
    expect(pv.json.data.balanceTotals).toMatchObject({ matched: 4, debit: 14000, credit: 300, net: 13700, existingOpeningNet: 500 })

    // How to read plain amounts is the user's explicit choice
    const plain = await post(preview, user, { ...body, options: { partyKind: 'customer', unsignedMeans: 'DR' } })
    expect((plain.json.data.rows as Row[])[6].messages[0]).toContain('No customer Plain Co')

    // Commit is refused with the reason; balances unchanged
    const c = await post(commit, user, { ...body, confirm: true, options: { partyKind: 'customer', goLiveDate: GO_LIVE } })
    expect(c.status).toBe(400)
    expect(c.json.error?.message).toContain('not imported yet')
    expect(await db.customer.findMany({ orderBy: { code: 'asc' }, select: { openingBalance: true } })).toEqual(before)
    expect(await db.auditLog.count()).toBe(0)
  })

  test('debit / credit columns (Vyapar style) and supplier sign convention', async () => {
    const { company, user } = await balanceSetup()
    const r = await post(preview, user, {
      companyId: company.id, dataType: 'opening-balances', headerRow: 0, mapping: { name: 0, debit: 1, credit: 2 }, options: { partyKind: 'supplier' },
      table: table([['Party Name', 'Receivable Balance', 'Payable Balance'], ['Tata Steel', '', '45,000'], ['Tata Steel', '10', '']]),
    })
    const rows = r.json.data.rows as Row[]
    expect(rows[0].extra).toMatchObject({ side: 'CR', amount: 45000, signed: 45000 }) // payable = + for a supplier
    expect(rows[1].messages[0]).toContain('already on row 2')
    expect(r.json.data.balanceTotals).toMatchObject({ matched: 1, credit: 45000, net: 45000 })
  })

  test('party kind and a go-live date are required', async () => {
    const { company, user } = await balanceSetup()
    const body = { companyId: company.id, dataType: 'opening-balances', headerRow: 0, mapping: { name: 0, balance: 1 }, table: table([['Name', 'Balance'], ['Shree Traders', '1 Dr']]) }
    expect((await post(preview, user, body)).json.error?.message).toContain('customer or supplier')
    await db.company.update({ where: { id: company.id }, data: { goLiveDate: null } })
    expect((await post(preview, user, { ...body, options: { partyKind: 'customer' } })).json.error?.message).toContain('Set the go-live date')
  })
})
