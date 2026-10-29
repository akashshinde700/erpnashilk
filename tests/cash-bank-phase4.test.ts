import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { db } from '@/lib/db'
import { accountBalances } from '@/lib/accounts'
import { balanceSheetFrom, cashFlow, endOfDayStr, positionAsOf, profitAndLoss, trialBalanceFrom } from '@/lib/accounting'
import { POST as createAccount } from '@/app/api/accounts/route'
import { GET as listPayments, POST as createPayment } from '@/app/api/payments/route'
import { DELETE as voidPayment, PATCH as patchPayment } from '@/app/api/payments/[id]/route'
import { POST as createSalesInvoice } from '@/app/api/sales-invoices/route'
import { POST as createPurchaseInvoice } from '@/app/api/purchase-invoices/route'
import { GET as listSalesReturns, POST as createSalesReturn } from '@/app/api/sales-returns/route'
import { PATCH as patchSalesReturn } from '@/app/api/sales-returns/[id]/route'
import { GET as listPurchaseReturns, POST as createPurchaseReturn } from '@/app/api/purchase-returns/route'
import { PATCH as patchPurchaseReturn } from '@/app/api/purchase-returns/[id]/route'
import { GET as customerStatement } from '@/app/api/customers/[id]/statement/route'
import { GET as partyView } from '@/app/api/parties/[kind]/[id]/route'
import { GET as history } from '@/app/api/cash-bank/transactions/route'
import { apiRequest, call, ctx } from './helpers/api'
import { resetDb } from './helpers/db'
import { seedTenant } from './helpers/seed'

/**
 * Cash & Bank Phase 4: customer advances (liability until applied), sales-return credit (refund or apply to another
 * invoice), purchase-return refunds. A fresh company with NO opening balances, so the balance-sheet balancing figure
 * and the trial-balance difference must stay exactly 0 — nothing is hidden.
 */

const NOW = new Date('2026-06-01T06:00:00Z')

async function setup() {
  const t = await seedTenant()
  const c = t.company.id
  const send = (handler: (r: Request, x?: never) => Promise<Response>, path: string, body: Record<string, unknown>, method?: string, id?: string) =>
    call((handler as (r: Request, x: unknown) => Promise<Response>)(apiRequest(path, { user: t.user, method, body: { companyId: c, ...body } }), id ? ctx({ id }) : undefined))
  const ok = async (p: Promise<{ status: number; json: { error?: { message: string }; data?: any } }>) => {
    const r = await p
    expect([r.status, r.json.error?.message]).toEqual([200, undefined])
    return r.json.data
  }
  const cash = (await ok(send(createAccount, '/api/accounts', { type: 'CASH', name: 'Cash in Hand', isDefault: true }))).id as string
  const bank = (await ok(send(createAccount, '/api/accounts', { type: 'BANK', name: 'Main Bank', isDefault: true }))).id as string
  const [customer, other, supplier, item] = await Promise.all([
    db.customer.create({ data: { companyId: c, code: 'C-1', name: 'Asha Traders' } }),
    db.customer.create({ data: { companyId: c, code: 'C-2', name: 'Other Customer' } }),
    db.supplier.create({ data: { companyId: c, code: 'S-1', name: 'Bharat Steels' } }),
    db.item.create({ data: { companyId: c, code: 'IT-1', name: 'Test Part', uom: 'NOS' } }),
  ])
  const invoice = (amount: number, extra: Record<string, unknown> = {}, customerId = customer.id) =>
    ok(send(createSalesInvoice, '/api/sales-invoices', { customerId, date: '2026-05-05', lines: [{ itemId: item.id, qty: amount / 100, rate: 100, discountPct: 0, gstRate: 0 }], ...extra }))
  const advance = (amount: number, extra: Record<string, unknown> = {}) =>
    send(createPayment, '/api/payments', { type: 'RECEIPT', invoiceType: 'ADVANCE', customerId: customer.id, amount, mode: 'CASH', date: '2026-05-02', ...extra })
  const apply = (advanceId: string, invoiceId: string, amount: number, extra: Record<string, unknown> = {}) =>
    send(patchPayment as never, `/api/payments/${advanceId}`, { action: 'apply', invoiceId, amount, date: '2026-05-10', ...extra }, 'PATCH', advanceId)
  const voidRow = (id: string) => send(voidPayment as never, `/api/payments/${id}`, {}, 'DELETE', id)
  const salesReturn = async (invoiceId: string, qty: number) => {
    const line = await db.salesInvoiceItem.findFirstOrThrow({ where: { invoiceId } })
    return ok(send(createSalesReturn, '/api/sales-returns', { invoiceId, date: '2026-05-12', lines: [{ invoiceItemId: line.id, qty }] }))
  }
  const refundCustomer = (returnId: string, amount: number, extra: Record<string, unknown> = {}) =>
    send(createPayment, '/api/payments', { type: 'PAYMENT', invoiceType: 'SALES_RETURN', invoiceId: returnId, customerId: customer.id, amount, mode: 'CASH', date: '2026-05-15', ...extra })
  const applyReturn = (returnId: string, invoiceId: string, amount: number) =>
    send(patchSalesReturn as never, `/api/sales-returns/${returnId}`, { action: 'apply', invoiceId, amount, date: '2026-05-15' }, 'PATCH', returnId)
  const cancelSalesReturn = (id: string) => send(patchSalesReturn as never, `/api/sales-returns/${id}`, { action: 'cancel' }, 'PATCH', id)
  const cashNow = async () => (await accountBalances(c)).find((b) => b.id === cash)!.balance
  const reports = async () => {
    const asOf = endOfDayStr('2026-05-31')
    const pos = await positionAsOf(c, asOf)
    const bs = balanceSheetFrom(pos)
    return {
      pos, bs, plug: bs.equity.find((e) => e.key === 'openingDiff')!.amount, tb: trialBalanceFrom(pos).difference,
      pl: await profitAndLoss(c, new Date('2026-04-01'), asOf), cf: (await cashFlow(c, new Date('2026-04-01'), asOf)).difference,
    }
  }
  const balanced = async () => {
    const r = await reports()
    expect({ plug: r.plug, tb: r.tb, cf: r.cf, assetsEqualLiabEq: r.bs.totalAssets === r.bs.totalLiabilitiesAndEquity }).toEqual({ plug: 0, tb: 0, cf: 0, assetsEqualLiabEq: true })
    return r
  }
  return { t, c, cash, bank, customer, other, supplier, item, send, ok, invoice, advance, apply, voidRow, salesReturn, refundCustomer, applyReturn, cancelSalesReturn, cashNow, reports, balanced }
}
type S = Awaited<ReturnType<typeof setup>>

beforeEach(async () => { setSystemTime(NOW); await resetDb() })
afterEach(() => { setSystemTime() })

describe('customer advances', () => {
  test('receiving an advance: cash up, "Customer advances" liability up, no sales income, receivable unchanged', async () => {
    const s = await setup()
    await s.invoice(1000)
    const before = await s.balanced()
    const r = await s.advance(5000)
    expect([r.status, r.json.data.invoiceType, r.json.data.invoiceId]).toEqual([200, 'ADVANCE', null])
    expect(await s.cashNow()).toBe(5000)
    const after = await s.balanced()
    expect(after.pos.customerAdvances).toBe(5000)
    expect(after.bs.liabilities.find((l) => l.key === 'customerAdvances')?.amount).toBe(5000)
    expect([after.pos.receivable, after.pl.sales.net, after.pl.netProfit]).toEqual([before.pos.receivable, before.pl.sales.net, before.pl.netProfit])
  })

  test('refused: post-dated cheque, an invoice on an advance, an advance to a supplier, unknown customer', async () => {
    const s = await setup()
    const inv = await s.invoice(1000)
    const pdc = await s.advance(500, { mode: 'CHEQUE', accountId: s.bank, chequeNo: '1', chequeDate: '2026-06-20' })
    expect([pdc.status, pdc.json.error?.message]).toEqual([400, 'A post-dated cheque cannot be taken as an advance — record it when the cheque date arrives'])
    expect((await s.advance(500, { invoiceId: inv.id })).status).toBe(400)
    expect((await s.send(createPayment, '/api/payments', { type: 'PAYMENT', invoiceType: 'ADVANCE', supplierId: s.supplier.id, amount: 100, mode: 'CASH' })).status).toBe(400)
    expect((await s.advance(500, { customerId: 'nope' })).status).toBe(404)
    expect(await db.payment.count({ where: { companyId: s.c, invoiceType: 'ADVANCE' } })).toBe(0)
  })

  test('partial application across two invoices: no cash moves; receivable and liability fall together; remaining shown', async () => {
    const s = await setup()
    const inv1 = await s.invoice(1000)
    const inv2 = await s.invoice(2000)
    const adv = (await s.advance(2500)).json.data
    const cashAfterAdvance = await s.cashNow()
    const a1 = await s.apply(adv.id, inv1.id, 1000)
    const a2 = await s.apply(adv.id, inv2.id, 1200)
    expect([a1.status, a2.status, a2.json.data.mode, a2.json.data.allocatedFromId, a2.json.data.remainingAfter]).toEqual([200, 200, 'ADVANCE_ADJ', adv.id, 300])
    expect(await s.cashNow()).toBe(cashAfterAdvance)
    const invs = await db.salesInvoice.findMany({ where: { id: { in: [inv1.id, inv2.id] } }, orderBy: { grandTotal: 'asc' }, select: { paidAmount: true, status: true } })
    expect(invs).toEqual([{ paidAmount: 1000, status: 'PAID' }, { paidAmount: 1200, status: 'PARTIALLY_PAID' }])
    const r = await s.balanced()
    expect([r.pos.customerAdvances, r.pos.receivable]).toEqual([300, 800])
    const list = await call(listPayments(apiRequest(`/api/payments?companyId=${s.c}`, { user: s.t.user })))
    const row = list.json.data.items.find((p: { id: string }) => p.id === adv.id)
    expect([row.kind, row.applied, row.remaining]).toEqual(['ADVANCE', 2200, 300])
    expect(list.json.data.items.filter((p: { kind: string }) => p.kind === 'ADVANCE_APPLIED').map((p: { sourceNumber: string }) => p.sourceNumber)).toEqual([adv.number, adv.number])
  })

  test('over-application refused: beyond the advance, beyond the invoice, another customer\'s invoice, before the advance date', async () => {
    const s = await setup()
    const inv = await s.invoice(1000)
    const big = await s.invoice(5000)
    const theirs = await s.invoice(1000, {}, s.other.id)
    const adv = (await s.advance(800)).json.data
    expect((await s.apply(adv.id, big.id, 900)).json.error?.message).toBe(`Only ₹800.00 is left on ${adv.number}`)
    const adv2 = (await s.advance(5000)).json.data
    expect((await s.apply(adv2.id, inv.id, 1200)).json.error?.message).toContain('Amount exceeds the outstanding')
    expect((await s.apply(adv2.id, theirs.id, 100)).json.error?.message).toContain('belongs to a different customer')
    expect((await s.apply(adv2.id, inv.id, 100, { date: '2026-05-01' })).status).toBe(400)
    expect(await db.payment.count({ where: { companyId: s.c, mode: 'ADVANCE_ADJ' } })).toBe(0)
    expect((await db.salesInvoice.findUniqueOrThrow({ where: { id: inv.id } })).paidAmount).toBe(0)
  })

  test('concurrent applications cannot apply the same advance twice', async () => {
    const s = await setup()
    const inv1 = await s.invoice(1000)
    const inv2 = await s.invoice(1000)
    const adv = (await s.advance(1000)).json.data
    const both = await Promise.all([s.apply(adv.id, inv1.id, 700), s.apply(adv.id, inv2.id, 700)])
    expect(both.map((r) => r.status).sort()).toEqual([200, 400])
    const applied = await db.payment.aggregate({ where: { companyId: s.c, allocatedFromId: adv.id }, _sum: { amount: true } })
    expect(applied._sum.amount).toBe(700)
    await s.balanced()
  })

  test('removing an application restores the invoice outstanding and the advance balance; no cash moves', async () => {
    const s = await setup()
    const inv = await s.invoice(1000)
    const adv = (await s.advance(1000)).json.data
    const app = (await s.apply(adv.id, inv.id, 600)).json.data
    const cashBefore = await s.cashNow()
    expect((await s.voidRow(app.id)).status).toBe(200)
    expect(await db.salesInvoice.findUniqueOrThrow({ where: { id: inv.id }, select: { paidAmount: true, status: true } })).toEqual({ paidAmount: 0, status: 'UNPAID' })
    expect(await s.cashNow()).toBe(cashBefore)
    const r = await s.balanced()
    expect([r.pos.customerAdvances, r.pos.receivable]).toEqual([1000, 1000])
  })

  test('an applied advance cannot be voided or bounced until its applications are removed', async () => {
    const s = await setup()
    const inv = await s.invoice(1000)
    const adv = (await s.advance(1000, { mode: 'CHEQUE', accountId: s.bank, chequeNo: '7' })).json.data // dated today: not post-dated
    const app = (await s.apply(adv.id, inv.id, 400)).json.data
    const v = await s.voidRow(adv.id)
    expect([v.status, v.json.error?.message]).toEqual([400, '₹400.00 of this advance is applied to invoices — remove those applications first'])
    const b = await s.send(patchPayment as never, `/api/payments/${adv.id}`, { action: 'bounce' }, 'PATCH', adv.id)
    expect(b.status).toBe(400)
    expect((await db.payment.findUniqueOrThrow({ where: { id: adv.id } })).chequeStatus).toBeNull()
    expect((await s.voidRow(app.id)).status).toBe(200)
    expect((await s.send(patchPayment as never, `/api/payments/${adv.id}`, { action: 'bounce' }, 'PATCH', adv.id)).status).toBe(200)
    const r = await s.balanced()
    expect(r.pos.customerAdvances).toBe(0) // a bounced advance is no liability
    expect((await accountBalances(s.c)).find((x) => x.id === s.bank)?.balance).toBe(0)
  })
})

describe('sales-return credit', () => {
  async function paidInvoiceWithReturn(s: S) {
    const inv = await s.invoice(1000, { receivedAmount: 1000, receivedMode: 'CASH' }) // fully paid, no stock moved
    const ret = await s.salesReturn(inv.id, 3) // ₹300 credit, nothing outstanding to adjust → all owed to the customer
    return { inv, ret }
  }

  test('full and partial refunds: cash down, refund liability down, P&L untouched; excess refused; remaining tracked', async () => {
    const s = await setup()
    const { ret } = await paidInvoiceWithReturn(s)
    const before = await s.balanced()
    expect(before.pos.customerCredits).toBe(300)
    expect(before.bs.liabilities.find((l) => l.key === 'customerCredits')?.amount).toBe(300)
    expect((await s.refundCustomer(ret.id, 100)).status).toBe(200)
    expect((await s.refundCustomer(ret.id, 250)).json.error?.message).toBe(`Refund exceeds the credit left on ${ret.number} (₹200.00)`)
    expect((await s.refundCustomer(ret.id, 200)).status).toBe(200)
    expect((await s.refundCustomer(ret.id, 1)).status).toBe(400)
    expect(await s.cashNow()).toBe(1000 - 300)
    const after = await s.balanced()
    expect([after.pos.customerCredits, after.pl.netProfit, after.pl.sales.net]).toEqual([0, before.pl.netProfit, before.pl.sales.net])
    const list = await call(listSalesReturns(apiRequest(`/api/sales-returns?companyId=${s.c}`, { user: s.t.user })))
    expect(list.json.data.items[0].credit).toEqual({ total: 300, appliedToInvoice: 0, appliedElsewhere: 0, refunded: 300, remaining: 0 })
  })

  test('concurrent refunds cannot exceed the credit; a refund to the wrong customer is refused', async () => {
    const s = await setup()
    const { ret } = await paidInvoiceWithReturn(s)
    const both = await Promise.all([s.refundCustomer(ret.id, 200), s.refundCustomer(ret.id, 200)])
    expect(both.map((r) => r.status).sort()).toEqual([200, 400])
    expect((await s.refundCustomer(ret.id, 50, { customerId: s.other.id })).status).toBe(400)
    await s.balanced()
  })

  test('credit applied to another invoice: no cash, liability and receivable fall, never counted as an advance; removable', async () => {
    const s = await setup()
    const { ret } = await paidInvoiceWithReturn(s)
    const inv2 = await s.invoice(1000)
    const cashBefore = await s.cashNow()
    const r = await s.applyReturn(ret.id, inv2.id, 300)
    expect([r.status, r.json.data.mode, r.json.data.allocatedFromId]).toEqual([200, 'CREDIT_NOTE', ret.id])
    expect(await s.cashNow()).toBe(cashBefore)
    expect((await db.salesInvoice.findUniqueOrThrow({ where: { id: inv2.id } })).paidAmount).toBe(300)
    let rep = await s.balanced()
    expect([rep.pos.customerCredits, rep.pos.customerAdvances, rep.pos.receivable]).toEqual([0, 0, 700])
    expect((await s.applyReturn(ret.id, inv2.id, 1)).status).toBe(400) // nothing left
    expect((await s.voidRow(r.json.data.id)).status).toBe(200)
    rep = await s.balanced()
    expect([rep.pos.customerCredits, rep.pos.receivable]).toEqual([300, 1000])
  })

  test('return cancel is blocked while refunds or applications exist; void them, then cancel works', async () => {
    const s = await setup()
    const { inv, ret } = await paidInvoiceWithReturn(s)
    const inv2 = await s.invoice(1000)
    const refund = (await s.refundCustomer(ret.id, 100)).json.data
    const app = (await s.applyReturn(ret.id, inv2.id, 50)).json.data
    const c1 = await s.cancelSalesReturn(ret.id)
    expect([c1.status, c1.json.error?.message]).toEqual([400, `${ret.number} has 1 refund and 1 application to other invoices — void them first`])
    expect((await db.salesReturn.findUniqueOrThrow({ where: { id: ret.id } })).status).toBe('POSTED')
    expect((await s.voidRow(refund.id)).status).toBe(200)
    expect((await s.voidRow(app.id)).status).toBe(200)
    expect((await s.cancelSalesReturn(ret.id)).status).toBe(200)
    expect((await db.salesInvoice.findUniqueOrThrow({ where: { id: inv.id } })).paidAmount).toBe(1000)
    const r = await s.balanced()
    expect([r.pos.customerCredits, r.pos.receivable]).toEqual([0, 1000])
    expect(await s.cashNow()).toBe(1000)
  })
})

describe('purchase-return refunds', () => {
  async function paidBillWithReturn(s: S) {
    const bill = await s.ok(s.send(createPurchaseInvoice, '/api/purchase-invoices', {
      supplierId: s.supplier.id, date: '2026-05-03', lines: [{ itemId: s.item.id, qty: 10, rate: 100, gstRate: 0 }],
      receiveStock: true, warehouseId: s.t.warehouse.id, paidNow: 1000, paymentMode: 'CASH',
    }))
    const ret = await s.ok(s.send(createPurchaseReturn, '/api/purchase-returns', { invoiceId: bill.id, date: '2026-05-12', warehouseId: s.t.warehouse.id, lines: [{ invoiceItemId: bill.items[0].id, qty: 2 }] }))
    return { bill, ret: ret as { id: string; number: string } }
  }
  // Repeat refunds of the same amount on one day are deliberate here (Phase 5 duplicate warning confirmed)
  const refundFromSupplier = (s: S, returnId: string, amount: number) =>
    s.send(createPayment, '/api/payments', { type: 'RECEIPT', invoiceType: 'PURCHASE_RETURN', invoiceId: returnId, supplierId: s.supplier.id, amount, mode: 'CASH', date: '2026-05-16', confirmDuplicate: true })

  test('full and partial refunds: cash up, "Refunds due from suppliers" down, no income; excess and concurrent refused', async () => {
    const s = await setup()
    await s.send(createPayment, '/api/payments', { type: 'RECEIPT', invoiceType: 'ADVANCE', customerId: s.customer.id, amount: 2000, mode: 'CASH', date: '2026-05-01' }) // cash to pay the bill
    const { ret } = await paidBillWithReturn(s)
    const before = await s.balanced()
    expect(before.pos.supplierRefunds).toBe(200)
    expect(before.bs.assets.find((a) => a.key === 'supplierRefunds')?.amount).toBe(200)
    expect((await refundFromSupplier(s, ret.id, 50)).status).toBe(200)
    expect((await refundFromSupplier(s, ret.id, 200)).json.error?.message).toBe(`Refund exceeds what is still due on ${ret.number} (₹150.00)`)
    const both = await Promise.all([refundFromSupplier(s, ret.id, 100), refundFromSupplier(s, ret.id, 100)])
    expect(both.map((r) => r.status).sort()).toEqual([200, 400])
    expect((await refundFromSupplier(s, ret.id, 50)).status).toBe(200)
    const after = await s.balanced()
    expect([after.pos.supplierRefunds, after.pl.netProfit]).toEqual([0, before.pl.netProfit])
    expect(await s.cashNow()).toBe(2000 - 1000 + 200)
    const list = await call(listPurchaseReturns(apiRequest(`/api/purchase-returns?companyId=${s.c}`, { user: s.t.user })))
    expect(list.json.data.items[0].refund).toEqual({ total: 200, appliedToBill: 0, refunded: 200, remaining: 0 })
  })

  test('return cancel is blocked while a refund exists; void it, then cancel works', async () => {
    const s = await setup()
    await s.send(createPayment, '/api/payments', { type: 'RECEIPT', invoiceType: 'ADVANCE', customerId: s.customer.id, amount: 2000, mode: 'CASH', date: '2026-05-01' })
    const { ret } = await paidBillWithReturn(s)
    const refund = (await refundFromSupplier(s, ret.id, 80)).json.data
    const cancel = () => s.send(patchPurchaseReturn as never, `/api/purchase-returns/${ret.id}`, { action: 'cancel' }, 'PATCH', ret.id)
    const c1 = await cancel()
    expect([c1.status, c1.json.error?.message]).toEqual([400, `${ret.number} has 1 refund received — void it first`])
    expect((await s.voidRow(refund.id)).status).toBe(200)
    expect((await cancel()).status).toBe(200)
    const r = await s.balanced()
    expect(r.pos.supplierRefunds).toBe(0)
  })
})

describe('ledgers and reports', () => {
  test('customer statement: bounced cheque left out, refund is a debit, credit-note excess a credit, applications not repeated; closing = ledger', async () => {
    const s = await setup()
    const inv1 = await s.invoice(1000)
    const chq = (await s.send(createPayment, '/api/payments', { type: 'RECEIPT', customerId: s.customer.id, invoiceType: 'SALES', invoiceId: inv1.id, amount: 400, mode: 'CHEQUE', accountId: s.bank, chequeNo: '9', date: '2026-05-06' })).json.data
    expect((await s.send(patchPayment as never, `/api/payments/${chq.id}`, { action: 'bounce' }, 'PATCH', chq.id)).status).toBe(200)
    await s.send(createPayment, '/api/payments', { type: 'RECEIPT', customerId: s.customer.id, invoiceType: 'SALES', invoiceId: inv1.id, amount: 300, mode: 'CASH', date: '2026-05-07' })
    const adv = (await s.advance(500)).json.data
    await s.apply(adv.id, inv1.id, 200)
    const inv2 = await s.invoice(500, { receivedAmount: 500, receivedMode: 'CASH' })
    const ret = await s.salesReturn(inv2.id, 1) // ₹100 credit, all owed to the customer
    await s.refundCustomer(ret.id, 60)

    const st = await call(customerStatement(apiRequest(`/api/customers/${s.customer.id}/statement?companyId=${s.c}&from=2026-04-01&to=2026-05-31`, { user: s.t.user }), ctx({ id: s.customer.id })))
    expect(st.status).toBe(200)
    const rows = st.json.data.rows as { type: string; ref: string; particulars: string; debit: number; credit: number }[]
    expect(rows.some((r) => r.ref === chq.number)).toBe(false) // bounced
    expect(rows.filter((r) => r.type === 'REFUND').map((r) => [r.debit, r.credit])).toEqual([[60, 0]])
    expect(rows.filter((r) => r.type === 'CREDIT_NOTE').map((r) => [r.ref, r.credit])).toEqual([[ret.number, 100]])
    expect(rows.some((r) => r.particulars.includes('applied'))).toBe(false)
    // 1000 + 500 − 300 − 500 (advance) − 500 − 100 (credit note) + 60 (refund) = 160
    expect(st.json.data.totals.closing).toBe(160)

    // the same figure from the ledger: receivable − advance left − credit left
    const view = await call(partyView(apiRequest(`/api/parties/customer/${s.customer.id}?companyId=${s.c}`, { user: s.t.user }), { params: Promise.resolve({ kind: 'customer', id: s.customer.id }) }))
    const sum = view.json.data.asCustomer.summary
    expect({ outstanding: sum.outstanding, advance: sum.advanceBalance, credit: sum.creditBalance, net: sum.netBalance, received: sum.received, refunded: sum.refunded })
      .toEqual({ outstanding: 500, advance: 300, credit: 40, net: 160, received: 300 + 500 + 500, refunded: 60 })
    await s.balanced()
  })

  test('supplier summary: refunds received are not "paid"; refund still due is shown', async () => {
    const s = await setup()
    await s.advance(3000)
    const bill = await s.ok(s.send(createPurchaseInvoice, '/api/purchase-invoices', {
      supplierId: s.supplier.id, date: '2026-05-03', lines: [{ itemId: s.item.id, qty: 10, rate: 100, gstRate: 0 }],
      receiveStock: true, warehouseId: s.t.warehouse.id, paidNow: 1000, paymentMode: 'CASH',
    }))
    const ret = await s.ok(s.send(createPurchaseReturn, '/api/purchase-returns', { invoiceId: bill.id, date: '2026-05-12', warehouseId: s.t.warehouse.id, lines: [{ invoiceItemId: bill.items[0].id, qty: 3 }] }))
    await s.send(createPayment, '/api/payments', { type: 'RECEIPT', invoiceType: 'PURCHASE_RETURN', invoiceId: ret.id, supplierId: s.supplier.id, amount: 100, mode: 'CASH', date: '2026-05-16' })
    const view = await call(partyView(apiRequest(`/api/parties/supplier/${s.supplier.id}?companyId=${s.c}`, { user: s.t.user }), { params: Promise.resolve({ kind: 'supplier', id: s.supplier.id }) }))
    const sum = view.json.data.asSupplier.summary
    expect({ paid: sum.paid, refundReceived: sum.refundReceived, refundDue: sum.refundDue, outstanding: sum.outstanding }).toEqual({ paid: 1000, refundReceived: 100, refundDue: 200, outstanding: 0 })
    await s.balanced()
  })

  test('Cash & Bank history shows advances and refunds as money; applications are not money', async () => {
    const s = await setup()
    const { inv, ret } = await (async () => {
      const i = await s.invoice(1000, { receivedAmount: 1000, receivedMode: 'CASH' })
      return { inv: i, ret: await s.salesReturn(i.id, 2) }
    })()
    void inv
    const adv = (await s.advance(400)).json.data
    const inv2 = await s.invoice(1000)
    await s.apply(adv.id, inv2.id, 150)
    await s.applyReturn(ret.id, inv2.id, 50)
    await s.refundCustomer(ret.id, 100)
    const h = await call(history(apiRequest(`/api/cash-bank/transactions?companyId=${s.c}&accountId=${s.cash}`, { user: s.t.user })))
    const rows = h.json.data.items as { number: string; type: string; moneyIn: number; moneyOut: number }[]
    expect(rows.find((r) => r.number === adv.number)).toMatchObject({ type: 'PAYMENT_IN', moneyIn: 400 })
    expect(rows.filter((r) => r.type === 'PAYMENT_OUT').map((r) => r.moneyOut)).toEqual([100])
    expect(rows.some((r) => r.number.startsWith('ADJ'))).toBe(false)
    expect(h.json.data.closing).toBe(1000 + 400 - 100)
    await s.balanced()
  })
})
