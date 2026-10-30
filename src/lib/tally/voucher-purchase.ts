import type { TallyCompanyInput, TallyEntry, TallyItemLine, TallyVoucher } from './voucher'
import { tallyDate } from './voucher'

/**
 * Tally purchase-voucher builder — the buying side of `buildTallyVoucher()`.
 *
 * A purchase bill is the mirror image of a sales invoice: the supplier is **credited** with the
 * bill total, while the purchase ledger, the input-tax ledgers and the stock lines are **debited**.
 * Everything Tally is strict about (identical ledger names, ASCII + escaped text, REMOTEID so a
 * re-import cannot double the books, one import envelope per voucher) applies exactly as it does on
 * the sales side, so the two builders share the same output shape and the same XML writer.
 *
 * Ledger names: unlike the sales side there are no per-company columns for the purchase ledgers yet
 * (that would be a schema change), so they come from the environment with Tally's usual defaults.
 * `ledgerNames()` still supplies freight and round-off, which are shared by both sides.
 */

export interface TallyBillItemInput {
  description?: string | null
  itemName?: string | null
  hsn?: string | null
  uom?: string | null
  qty?: number | null
  rate?: number | null
  amount?: number | null
  lineTotal?: number | null
}

export interface TallyBillInput {
  id: string
  number: string
  date: Date | string
  status?: string | null
  subtotal: number
  discountTotal?: number | null
  cgst: number
  sgst: number
  igst: number
  cess?: number | null
  grandTotal: number
  roundOff?: number | null
  freightCharge?: number | null
  packingCharge?: number | null
  isInterState?: boolean | null
  reverseCharge?: boolean | null
  supplierInvNo?: string | null
  supplierInvDate?: Date | string | null
  supplier?: { name?: string | null; gstin?: string | null; tallyLedgerName?: string | null } | null
  items?: TallyBillItemInput[] | null
}

export interface TallyPurchaseLedgers {
  purchase: string
  cgst: string
  sgst: string
  igst: string
  cess: string
  freight: string
  roundOff: string
}

const round2 = (n: number) => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100

/** Purchase-side ledgers: env override → the default Tally names. */
export function purchaseLedgerNames(
  env: Record<string, string | undefined> = process.env,
  shared: { freight: string; roundOff: string } = { freight: 'Transport & Freight Charges', roundOff: 'Round Off' },
): TallyPurchaseLedgers {
  const pick = (value: string | undefined, fallback: string) => (value || '').trim() || fallback
  return {
    purchase: pick(env.TALLY_LEDGER_PURCHASE, 'Purchase'),
    cgst: pick(env.TALLY_LEDGER_CGST_INPUT, 'Input Central Tax @ 9%'),
    sgst: pick(env.TALLY_LEDGER_SGST_INPUT, 'Input State Tax @ 9%'),
    igst: pick(env.TALLY_LEDGER_IGST_INPUT, 'Input Integrated Tax @ 18%'),
    cess: pick(env.TALLY_LEDGER_CESS_INPUT, 'Input Cess'),
    freight: shared.freight,
    roundOff: shared.roundOff,
  }
}

/** Build the purchase voucher model (same shape as a sales voucher, so one XML writer serves both). */
export function buildPurchaseVoucher(
  bill: TallyBillInput,
  company: TallyCompanyInput = {},
  ledgers: TallyPurchaseLedgers = purchaseLedgerNames(),
): TallyVoucher {
  const date = tallyDate(bill.date)
  if (!date) throw new Error('Bill has no valid invoice date — Tally would reject the voucher.')
  if ((bill.status || '').toUpperCase() === 'CANCELLED') {
    throw new Error('A cancelled bill cannot be pushed to Tally — cancel it in Tally instead.')
  }

  const warnings: string[] = []
  const party = (bill.supplier?.tallyLedgerName || '').trim() || bill.supplier?.name || 'Supplier'
  const partyGstin = (bill.supplier?.gstin || '').trim()
  if (!partyGstin) warnings.push(`Supplier "${party}" has no GSTIN — Tally will book the purchase without a GST registration.`)
  if (bill.reverseCharge) {
    warnings.push('Reverse charge is set on this bill — the tax is self-assessed, so Tally needs the RCM tax ledgers rather than ordinary input credit.')
  }

  const grandTotal = round2(bill.grandTotal)
  const subtotal = round2(bill.subtotal)
  const cgst = round2(bill.cgst || 0)
  const sgst = round2(bill.sgst || 0)
  const igst = round2(bill.igst || 0)
  const cess = round2(bill.cess || 0)
  const freight = round2((bill.freightCharge || 0) + (bill.packingCharge || 0))

  const rows = bill.items || []
  const items: TallyItemLine[] = rows.map((it) => {
    const rate = Number(it.rate) || 0
    const qty = Number(it.qty) || 0
    let amount = round2(Number(it.amount ?? it.lineTotal) || (qty ? qty * rate : 0))
    let quantity = qty
    if (rate > 0 && Math.abs(quantity * rate - amount) >= 0.01) quantity = amount / rate
    if (!Number.isFinite(amount)) amount = 0
    if (rate > 0) amount = round2(quantity * rate)
    return {
      stockItem: (it.itemName || it.description || 'Purchase').trim(),
      description: (it.description || '').trim(),
      hsn: (it.hsn || '').trim(),
      quantity: Math.round(quantity * 1000) / 1000,
      unit: (it.uom || 'Nos').trim(),
      rate: round2(rate),
      amount,
      salesLedger: ledgers.purchase,
    }
  })
  if (!items.length) warnings.push('Bill has no lines — it will import as a ledger-only voucher.')
  const itemsGivenHsn = items.filter((i) => i.hsn).length
  if (items.length && itemsGivenHsn < items.length) {
    warnings.push(`${items.length - itemsGivenHsn} line(s) have no HSN/SAC — Tally falls back to the stock item master.`)
  }
  const stockValue = round2(items.reduce((s, i) => s + i.amount, 0))

  // Debit side: purchase value (only when no stock lines carried it), then the input taxes.
  const itemMode = items.length > 0
  const debits: TallyEntry[] = [
    ...(itemMode ? [] : [{ ledger: ledgers.purchase, amount: subtotal, isParty: false, isDebit: true }]),
    { ledger: ledgers.cgst, amount: cgst, isParty: false, isDebit: true },
    { ledger: ledgers.sgst, amount: sgst, isParty: false, isDebit: true },
    { ledger: ledgers.igst, amount: igst, isParty: false, isDebit: true },
    { ledger: ledgers.cess, amount: cess, isParty: false, isDebit: true },
    { ledger: ledgers.freight, amount: freight, isParty: false, isDebit: true },
  ].filter((e) => e.amount > 0)

  const debitTotal = round2(debits.reduce((s, e) => s + e.amount, 0) + (itemMode ? stockValue : 0))
  const residual = round2(grandTotal - debitTotal)
  if (residual >= 0.01) {
    // The bill total is higher than the debits — the missing paise are a debit to Round Off.
    debits.push({ ledger: ledgers.roundOff, amount: residual, isParty: false, isDebit: true })
  } else if (residual <= -0.01) {
    // The debits overshoot — the extra is a credit to Round Off, so the voucher still balances.
    debits.push({ ledger: ledgers.roundOff, amount: round2(-residual), isParty: false, isDebit: false })
  }

  const entries: TallyEntry[] = [
    ...debits,
    { ledger: party, amount: grandTotal, isParty: true, isDebit: false, billRef: bill.supplierInvNo || bill.number },
  ]

  const supplierInvDate = tallyDate(bill.supplierInvDate)

  return {
    voucherType: 'Purchase',
    voucherNumber: bill.number,
    remoteId: `MANUFLOW-BILL-${bill.id}`,
    date,
    dateISO: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`,
    party,
    partyGstin,
    company: (company.name || '').trim() || null,
    gstin: {
      seller: partyGstin,
      buyer: (company.gstin || '').trim(),
      placeOfSupply: (company.state || '').trim(),
    },
    references: { order: (bill.supplierInvNo || '').trim(), po: supplierInvDate || '' },
    eInvoice: { irn: '', eWayBillNo: '' },
    flags: {
      reverseCharge: !!bill.reverseCharge,
      docType: 'PURCHASE',
      currency: 'INR',
      fxRate: 1,
    },
    items,
    entries,
    subtotal: stockValue || subtotal,
    grandTotal,
    warnings,
  }
}
