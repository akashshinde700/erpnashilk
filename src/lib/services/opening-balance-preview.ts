import { db } from '@/lib/db'
import { r2 } from '@/lib/erp-helpers'
import type { ImportInputRow, ImportRowResult, ImportSummary } from '@/lib/services/customer-import'

/**
 * Party opening balances — PREVIEW AND RECONCILIATION ONLY (never writes).
 *
 * ManuFlow keeps a party's opening balance as one undated number (Customer/Supplier.openingBalance)
 * that receivables, payables, statements and the balance sheet add to invoice outstanding. There is
 * no entry model behind it and no way to settle it: receipts / payments must reference an invoice
 * (POST /api/payments), so an imported opening receivable could never be collected in the books.
 * Writing imported balances into that field would therefore create outstanding amounts that can only
 * be removed by editing the party — see docs/opening-balances.md for the model that is needed.
 *
 * What this does: reads a debtor / creditor report (already normalised by apply-mapping to `amount` +
 * `side` DR/CR), matches each row to an existing customer or supplier, converts it to ManuFlow's sign
 * (customer: Dr = receivable +; supplier: Cr = payable +), flags parties that already carry an opening
 * balance or have documents dated before the go-live date, and totals Dr / Cr / net so the result can
 * be compared with the source report's totals.
 */

export interface OpeningBalanceTotals {
  rows: number
  matched: number
  debit: number
  credit: number
  /** Net in ManuFlow's sign for the party kind (receivable for customers, payable for suppliers). */
  net: number
  existingOpeningNet: number
}

export async function previewOpeningBalances(
  companyId: string, rows: ImportInputRow[], opts: { partyKind: 'customer' | 'supplier'; goLive: Date },
): Promise<ImportSummary & { totals: OpeningBalanceTotals }> {
  const isCustomer = opts.partyKind === 'customer'
  const parties = isCustomer
    ? await db.customer.findMany({ where: { companyId }, select: { id: true, code: true, name: true, gstin: true, openingBalance: true } })
    : await db.supplier.findMany({ where: { companyId }, select: { id: true, code: true, name: true, gstin: true, openingBalance: true } })
  const byCode = new Map(parties.map((p) => [p.code.toUpperCase(), p]))
  const byName = new Map(parties.map((p) => [p.name.trim().toLowerCase(), p]))
  const byGstin = new Map<string, (typeof parties)[number][]>()
  for (const p of parties) if (p.gstin) byGstin.set(p.gstin.toUpperCase(), [...(byGstin.get(p.gstin.toUpperCase()) ?? []), p])

  // Documents dated before go-live per party: an opening balance would count them twice
  const ids = parties.map((p) => p.id)
  const docsBefore = new Map<string, number>()
  if (ids.length) {
    const date = { lt: opts.goLive }
    const [invoices, payments] = isCustomer
      ? await Promise.all([
        db.salesInvoice.groupBy({ by: ['customerId'], where: { companyId, status: { not: 'CANCELLED' }, date }, _count: { _all: true } }),
        db.payment.groupBy({ by: ['customerId'], where: { companyId, customerId: { not: null }, date }, _count: { _all: true } }),
      ])
      : await Promise.all([
        db.purchaseInvoice.groupBy({ by: ['supplierId'], where: { companyId, status: { not: 'CANCELLED' }, date }, _count: { _all: true } }),
        db.payment.groupBy({ by: ['supplierId'], where: { companyId, supplierId: { not: null }, date }, _count: { _all: true } }),
      ])
    for (const g of [...invoices, ...payments] as { customerId?: string | null; supplierId?: string | null; _count: { _all: number } }[]) {
      const id = (isCustomer ? g.customerId : g.supplierId) as string | null
      if (id) docsBefore.set(id, (docsBefore.get(id) ?? 0) + g._count._all)
    }
  }

  const results: ImportRowResult[] = []
  const seen = new Map<string, number>()
  const totals: OpeningBalanceTotals = { rows: rows.length, matched: 0, debit: 0, credit: 0, net: 0, existingOpeningNet: 0 }
  let skipped = 0
  for (const { row: rowNo, data } of rows) {
    const name = String(data.name ?? '').trim()
    const code = String(data.code ?? '').trim()
    const gstin = String(data.gstin ?? '').trim().toUpperCase()
    const amount = Number(data.amount)
    const side = data.side === 'DR' || data.side === 'CR' ? data.side : null
    const res: ImportRowResult = { row: rowNo, status: 'ready', warnings: [], name: name || code || undefined }
    results.push(res)
    const reject = (message: string, dup = false) => { res.status = dup ? 'skipped' : 'error'; res.message = message; if (dup) skipped++ }

    let party = code ? byCode.get(code.toUpperCase()) : byName.get(name.toLowerCase())
    if (code && party && name && party.name.trim().toLowerCase() !== name.toLowerCase()) { reject(`Code ${party.code} is "${party.name}", but the file says "${name}"`); continue }
    if (!party && gstin) {
      const hits = byGstin.get(gstin) ?? []
      if (hits.length === 1) { party = hits[0]; res.warnings.push(`Matched by GSTIN to ${party.code} ${party.name}`) }
    }
    if (!party) { reject(`No ${opts.partyKind} ${code || name} — import the ${isCustomer ? 'customers' : 'suppliers'} first`); continue }
    res.name = `${party.code} ${party.name}`
    res.code = party.code
    if (!Number.isFinite(amount) || amount < 0 || (amount > 0 && !side)) { reject('Balance or Dr / Cr could not be read'); continue }
    if (amount === 0) { reject('Zero balance — nothing to bring forward', true); continue }
    const earlier = seen.get(party.id)
    if (earlier !== undefined) { reject(`${party.code} is already on row ${earlier}`); continue }
    seen.set(party.id, rowNo)

    // ManuFlow sign: customer Dr = they owe us (+); supplier Cr = we owe them (+)
    const signed = r2((side === 'DR') === isCustomer ? amount : -amount)
    totals.matched++
    if (side === 'DR') totals.debit = r2(totals.debit + amount)
    else totals.credit = r2(totals.credit + amount)
    totals.net = r2(totals.net + signed)
    totals.existingOpeningNet = r2(totals.existingOpeningNet + (party.openingBalance || 0))
    res.extra = { party: `${party.code} ${party.name}`, side: side as string, amount, signed, existing: r2(party.openingBalance || 0) }

    if (party.openingBalance) {
      reject(party.openingBalance === signed
        ? `${party.code} already has this opening balance (${party.openingBalance}) — would be a duplicate`
        : `${party.code} already has an opening balance of ${party.openingBalance} (file: ${signed})`, true)
      continue
    }
    const docs = docsBefore.get(party.id)
    if (docs) res.warnings.push(`${docs} invoice(s) / payment(s) dated before the go-live date are already in ManuFlow — the source balance may include them`)
    if (signed < 0) res.warnings.push(isCustomer ? 'Credit balance: an advance received from the customer' : 'Debit balance: an advance paid to the supplier')
  }
  return { imported: 0, skipped, failed: 0, results, totals }
}
