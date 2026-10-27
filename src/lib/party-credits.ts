import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { r2 } from '@/lib/erp-helpers'

/**
 * Customer advances and return credits / refunds (Cash & Bank Phase 4). All are Payment rows:
 *  - Customer advance: RECEIPT from a customer, invoiceType 'ADVANCE', no invoice. Money in; a liability
 *    ("Customer advances") until applied — never sales income.
 *  - Advance application: mode 'ADVANCE_ADJ', invoiceType 'SALES', invoiceId = the invoice, allocatedFromId = the
 *    advance. No money moves: the liability goes down and the invoice's paid amount goes up.
 *  - Sales-return credit = the return's grand total. Part of it settles the return's own invoice when the return is
 *    posted (CREDIT_NOTE row, reference = return number, allocatedFromId null); the rest is owed to the customer
 *    ("Refunds due to customers") until it is applied to another invoice of that customer (CREDIT_NOTE row,
 *    allocatedFromId = the return — no money) or refunded (PAYMENT to the customer, invoiceType 'SALES_RETURN',
 *    invoiceId = the return — money out). A return credit is never counted as a customer advance.
 *  - Purchase-return refund: the debit note's excess over its bill is owed by the supplier ("Refunds due from
 *    suppliers") until received (RECEIPT from the supplier, invoiceType 'PURCHASE_RETURN', invoiceId = the return).
 * Bounced cheques never count; post-dated (pending / deposited) refund cheques settle the party like any payment.
 */

export const ADVANCE = 'ADVANCE'
export const ADVANCE_ADJ = 'ADVANCE_ADJ'
export const SALES_RETURN = 'SALES_RETURN'
export const PURCHASE_RETURN = 'PURCHASE_RETURN'

type Tx = Prisma.TransactionClient | typeof db

/**
 * Module a role needs, on top of `payments`, to create / apply / void / bounce a payment of this kind (Phase 5):
 * customer receipts, advances and advance applications → sales invoices; customer refunds and return credits applied
 * to invoices → sales returns; supplier payments → purchase invoices; supplier refunds → purchase returns.
 */
export function paymentKindModule(p: { type: string; invoiceType?: string | null; mode?: string | null; allocatedFromId?: string | null }): string {
  if (p.invoiceType === SALES_RETURN || (p.mode === 'CREDIT_NOTE' && p.allocatedFromId)) return 'sales-returns'
  if (p.invoiceType === PURCHASE_RETURN) return 'purchase-returns'
  if (p.invoiceType === ADVANCE || p.mode === ADVANCE_ADJ || p.invoiceType === 'SALES') return 'sales-invoices'
  if (p.invoiceType === 'PURCHASE') return 'purchase-invoices'
  return p.type === 'RECEIPT' ? 'sales-invoices' : 'purchase-invoices'
}

/** Not bounced (a NULL cheque status is not matched by `not`, hence the OR). */
const notBounced = { OR: [{ chequeStatus: null }, { chequeStatus: { not: 'BOUNCED' } }] }
const sumBy = (rows: { key: string | null; amount: number | null }[]) => {
  const m = new Map<string, number>()
  for (const r of rows) if (r.key) m.set(r.key, r2((m.get(r.key) || 0) + (r.amount || 0)))
  return m
}

/** Amount already applied from each advance. */
export async function advanceApplied(tx: Tx, companyId: string, advanceIds: string[]) {
  if (!advanceIds.length) return new Map<string, number>()
  const rows = await (tx as typeof db).payment.groupBy({
    by: ['allocatedFromId'], where: { companyId, mode: ADVANCE_ADJ, allocatedFromId: { in: advanceIds } }, _sum: { amount: true },
  })
  return sumBy(rows.map((r) => ({ key: r.allocatedFromId, amount: r._sum.amount })))
}

export interface ReturnCredit { total: number; appliedToInvoice: number; appliedElsewhere: number; refunded: number; remaining: number }

/** Credit left on each sales return (cancelled returns have none). */
export async function salesReturnCredits(tx: Tx, companyId: string, rets: { id: string; number: string; invoiceId: string; grandTotal: number; status: string }[]) {
  const out = new Map<string, ReturnCredit>()
  const live = rets.filter((r) => r.status !== 'CANCELLED')
  if (live.length) {
    const t = tx as typeof db
    const [own, elsewhere, refunds] = await Promise.all([
      t.payment.findMany({ where: { companyId, mode: 'CREDIT_NOTE', invoiceType: 'SALES', allocatedFromId: null, reference: { in: live.map((r) => r.number) } }, select: { reference: true, invoiceId: true, amount: true } }),
      t.payment.groupBy({ by: ['allocatedFromId'], where: { companyId, mode: 'CREDIT_NOTE', allocatedFromId: { in: live.map((r) => r.id) } }, _sum: { amount: true } }),
      t.payment.groupBy({ by: ['invoiceId'], where: { companyId, invoiceType: SALES_RETURN, invoiceId: { in: live.map((r) => r.id) }, ...notBounced }, _sum: { amount: true } }),
    ])
    const ownBy = new Map<string, number>()
    for (const r of live) ownBy.set(r.id, r2(own.filter((p) => p.reference === r.number && p.invoiceId === r.invoiceId).reduce((s, p) => s + p.amount, 0)))
    const elsewhereBy = sumBy(elsewhere.map((r) => ({ key: r.allocatedFromId, amount: r._sum.amount })))
    const refundBy = sumBy(refunds.map((r) => ({ key: r.invoiceId, amount: r._sum.amount })))
    for (const r of live) {
      const c = { total: r2(r.grandTotal), appliedToInvoice: ownBy.get(r.id) || 0, appliedElsewhere: elsewhereBy.get(r.id) || 0, refunded: refundBy.get(r.id) || 0, remaining: 0 }
      c.remaining = Math.max(0, r2(c.total - c.appliedToInvoice - c.appliedElsewhere - c.refunded))
      out.set(r.id, c)
    }
  }
  for (const r of rets) if (!out.has(r.id)) out.set(r.id, { total: r2(r.grandTotal), appliedToInvoice: 0, appliedElsewhere: 0, refunded: 0, remaining: 0 })
  return out
}

export interface ReturnRefund { total: number; appliedToBill: number; refunded: number; remaining: number }

/** Refund still due from the supplier on each purchase return (cancelled returns have none). */
export async function purchaseReturnRefunds(tx: Tx, companyId: string, rets: { id: string; number: string; invoiceId: string; grandTotal: number; status: string }[]) {
  const out = new Map<string, ReturnRefund>()
  const live = rets.filter((r) => r.status !== 'CANCELLED')
  if (live.length) {
    const t = tx as typeof db
    const [own, refunds] = await Promise.all([
      t.payment.findMany({ where: { companyId, mode: 'DEBIT_NOTE', invoiceType: 'PURCHASE', reference: { in: live.map((r) => r.number) } }, select: { reference: true, invoiceId: true, amount: true } }),
      t.payment.groupBy({ by: ['invoiceId'], where: { companyId, invoiceType: PURCHASE_RETURN, invoiceId: { in: live.map((r) => r.id) }, ...notBounced }, _sum: { amount: true } }),
    ])
    const refundBy = sumBy(refunds.map((r) => ({ key: r.invoiceId, amount: r._sum.amount })))
    for (const r of live) {
      const applied = r2(own.filter((p) => p.reference === r.number && p.invoiceId === r.invoiceId).reduce((s, p) => s + p.amount, 0))
      const c = { total: r2(r.grandTotal), appliedToBill: applied, refunded: refundBy.get(r.id) || 0, remaining: 0 }
      c.remaining = Math.max(0, r2(c.total - c.appliedToBill - c.refunded))
      out.set(r.id, c)
    }
  }
  for (const r of rets) if (!out.has(r.id)) out.set(r.id, { total: r2(r.grandTotal), appliedToBill: 0, refunded: 0, remaining: 0 })
  return out
}

/**
 * Balance-sheet / trial-balance figures as of a date (optionally one party):
 *  customerAdvances  — advances received − applied            (liability)
 *  customerCredits   — sales-return credit not yet applied / refunded  (liability: refunds due to customers)
 *  supplierRefunds   — purchase-return excess not yet received       (asset: refunds due from suppliers)
 */
export async function partyCreditsAsOf(companyId: string, asOf?: Date, party: { customerId?: string; supplierId?: string } = {}) {
  const date = asOf ? { lte: asOf } : undefined
  const cust = party.customerId ? { customerId: party.customerId } : {}
  const supp = party.supplierId ? { supplierId: party.supplierId } : {}
  const [adv, applied, srets, credApplied, srefunds, prets, prefunds] = await Promise.all([
    db.payment.aggregate({ where: { companyId, type: 'RECEIPT', invoiceType: ADVANCE, ...cust, ...(date ? { date } : {}), ...notBounced }, _sum: { amount: true } }),
    db.payment.aggregate({ where: { companyId, mode: ADVANCE_ADJ, ...cust, ...(date ? { date } : {}) }, _sum: { amount: true } }),
    db.salesReturn.findMany({ where: { companyId, status: 'POSTED', ...cust, ...(date ? { date } : {}) }, select: { id: true, number: true, invoiceId: true, grandTotal: true } }),
    db.payment.aggregate({ where: { companyId, mode: 'CREDIT_NOTE', allocatedFromId: { not: null }, ...cust, ...(date ? { date } : {}) }, _sum: { amount: true } }),
    db.payment.aggregate({ where: { companyId, invoiceType: SALES_RETURN, ...cust, ...(date ? { date } : {}), ...notBounced }, _sum: { amount: true } }),
    db.purchaseReturn.findMany({ where: { companyId, status: 'POSTED', ...supp, ...(date ? { date } : {}) }, select: { id: true, number: true, invoiceId: true, grandTotal: true } }),
    db.payment.aggregate({ where: { companyId, invoiceType: PURCHASE_RETURN, ...supp, ...(date ? { date } : {}), ...notBounced }, _sum: { amount: true } }),
  ])
  const [sOwn, pOwn] = await Promise.all([
    srets.length ? db.payment.findMany({ where: { companyId, mode: 'CREDIT_NOTE', invoiceType: 'SALES', allocatedFromId: null, reference: { in: srets.map((r) => r.number) } }, select: { reference: true, invoiceId: true, amount: true } }) : [],
    prets.length ? db.payment.findMany({ where: { companyId, mode: 'DEBIT_NOTE', invoiceType: 'PURCHASE', reference: { in: prets.map((r) => r.number) } }, select: { reference: true, invoiceId: true, amount: true } }) : [],
  ])
  const excess = (rets: { number: string; invoiceId: string; grandTotal: number }[], own: { reference: string | null; invoiceId: string | null; amount: number }[]) =>
    rets.reduce((s, r) => s + r.grandTotal - own.filter((p) => p.reference === r.number && p.invoiceId === r.invoiceId).reduce((a, p) => a + p.amount, 0), 0)
  return {
    customerAdvances: r2((adv._sum.amount || 0) - (applied._sum.amount || 0)),
    customerCredits: r2(excess(srets, sOwn) - (credApplied._sum.amount || 0) - (srefunds._sum.amount || 0)),
    supplierRefunds: r2(excess(prets, pOwn) - (prefunds._sum.amount || 0)),
  }
}
