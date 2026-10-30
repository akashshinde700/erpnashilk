/**
 * Tally voucher export for sales invoices.
 *
 * Ported from the Tally integration of the Sheetaldies ERP
 * (akashshinde700/sheetaldies_erp, backend/src/controllers/invoice.controller.js).
 *
 * Three export shapes describe the *same* voucher, so they are all built from one
 * model (`buildTallyVoucher`) — a fix to the accounting shape lands in all of them:
 *
 *   XML   — TallyPrime import file (Gateway of Tally → Import Data, or drag onto
 *           Tally); this is the only route that needs no network path to Tally.
 *   JSON  — same voucher as plain data, for a script or another accounting tool.
 *   Excel — one row per item/ledger line, for accountants who check the voucher
 *           before importing it.
 *
 * Things Tally is strict about, and that this file therefore does:
 *
 *  - Ledger names must exist in the Tally company *spelled identically*. Tally
 *    never auto-creates a master on import; it raises an exception instead. Names
 *    come from the company settings, then env defaults (see `ledgerNames`).
 *  - The import parser is not a general XML parser: an unescaped `&`/`<` aborts
 *    the parse half-way, and non-ASCII bytes (the rupee sign, smart quotes) are
 *    mangled. Everything interpolated goes through `tallyText`.
 *  - REMOTEID is the external key for a voucher. Without it every re-import of
 *    the same invoice creates ANOTHER voucher and the books double-count.
 *  - Invoice-mode vouchers (ISINVOICE=Yes) read LEDGERENTRIES.LIST; double-entry
 *    vouchers read ALLLEDGERENTRIES.LIST. The wrong one is silently ignored and
 *    surfaces as "No accounting or inventory entries are available".
 *  - The party is debited with the grand total, so anything the other ledgers do
 *    not account for (round-off, freight rounding) must land on a Round Off line
 *    or Tally rejects the voucher as unbalanced.
 */

export interface TallyItemInput {
  description?: string | null
  itemName?: string | null
  hsn?: string | null
  uom?: string | null
  qty?: number | null
  rate?: number | null
  amount?: number | null
  discountPct?: number | null
  gstRate?: number | null
  cessRate?: number | null
}

export interface TallyInvoiceInput {
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
  placeOfSupply?: string | null
  isInterState?: boolean | null
  irn?: string | null
  ewayBillNo?: string | null
  docType?: string | null
  reverseCharge?: boolean | null
  currency?: string | null
  fxRate?: number | null
  notes?: string | null
  customer?: { name?: string | null; gstin?: string | null; tallyLedgerName?: string | null } | null
  customerPoNo?: string | null
  salesOrder?: { number?: string | null } | null
  items?: TallyItemInput[] | null
}

export interface TallyCompanyInput {
  name?: string | null
  gstin?: string | null
  state?: string | null
  stateCode?: string | null
}

export interface TallyLedgerNames {
  sales: string
  cgst: string
  sgst: string
  igst: string
  freight: string
  roundOff: string
  cess: string
}

/** Ledger mapping: explicit company setting → env override → the common default. */
export function ledgerNames(company?: {
  tallySalesLedger?: string | null
  tallyCgstLedger?: string | null
  tallySgstLedger?: string | null
  tallyIgstLedger?: string | null
  tallyFreightLedger?: string | null
  tallyRoundOffLedger?: string | null
}, env: Record<string, string | undefined> = process.env): TallyLedgerNames {
  const pick = (fromCompany: string | null | undefined, fromEnv: string | undefined, fallback: string) =>
    (fromCompany || '').trim() || (fromEnv || '').trim() || fallback
  return {
    sales: pick(company?.tallySalesLedger, env.TALLY_LEDGER_SALES, 'Sales'),
    cgst: pick(company?.tallyCgstLedger, env.TALLY_LEDGER_CGST, 'Central Tax on Sales @ 9%'),
    sgst: pick(company?.tallySgstLedger, env.TALLY_LEDGER_SGST, 'State Tax on Sales @ 9%'),
    igst: pick(company?.tallyIgstLedger, env.TALLY_LEDGER_IGST, 'Integrated Tax on Sales @ 18%'),
    freight: pick(company?.tallyFreightLedger, env.TALLY_LEDGER_FREIGHT, 'Transport & Freight Charges'),
    roundOff: pick(company?.tallyRoundOffLedger, env.TALLY_LEDGER_ROUNDOFF, 'Round Off'),
    cess: pick(undefined, env.TALLY_LEDGER_CESS, 'Cess on Sales'),
  }
}

const round2 = (n: number) => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100

/** Tally wants YYYYMMDD with no separators, read in UTC (dates are stored as UTC midnight). */
export function tallyDate(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
}

/**
 * Make a string safe for Tally's import parser: ASCII only (the rupee sign and
 * smart quotes are transliterated, everything else non-ASCII is dropped) and
 * XML-escaped.
 */
export function tallyText(value: unknown): string {
  return String(value ?? '')
    .replace(/₹/g, 'Rs.')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .trim()
}

export interface TallyEntry {
  ledger: string
  amount: number
  isParty: boolean
  isDebit: boolean
  billRef?: string | null
}

export interface TallyItemLine {
  stockItem: string
  description: string
  hsn: string
  quantity: number
  unit: string
  rate: number
  amount: number
  /** Accounting ledger the line posts to: the sales ledger on an invoice, the purchase ledger on a bill. */
  salesLedger: string
}

export interface TallyVoucher {
  voucherType: string
  voucherNumber: string
  remoteId: string
  date: string
  dateISO: string
  party: string
  partyGstin: string
  company: string | null
  gstin: { seller: string; buyer: string; placeOfSupply: string }
  references: { order: string; po: string }
  eInvoice: { irn: string; eWayBillNo: string }
  flags: { reverseCharge: boolean; docType: string; currency: string; fxRate: number }
  items: TallyItemLine[]
  entries: TallyEntry[]
  subtotal: number
  grandTotal: number
  warnings: string[]
}

/**
 * Build the voucher model shared by the XML / JSON / Excel exports.
 * Throws when the invoice cannot be represented at all (no date, cancelled).
 */
export function buildTallyVoucher(
  invoice: TallyInvoiceInput,
  company: TallyCompanyInput = {},
  ledgers: TallyLedgerNames = ledgerNames(),
): TallyVoucher {
  const date = tallyDate(invoice.date)
  if (!date) throw new Error('Invoice has no valid invoice date — Tally would reject the voucher.')
  if ((invoice.status || '').toUpperCase() === 'CANCELLED') {
    throw new Error('A cancelled invoice cannot be pushed to Tally — cancel it in Tally instead.')
  }

  const warnings: string[] = []
  const docType = invoice.docType || 'TAX_INVOICE'
  if (docType === 'PROFORMA') warnings.push('This is a proforma invoice — import it as a Sales Order, not as a sales voucher.')
  if ((invoice.currency || 'INR') !== 'INR') {
    warnings.push(`Invoice is in ${invoice.currency} — the voucher is raised in INR at the recorded exchange rate (${invoice.fxRate || 1}).`)
  }

  const party = (invoice.customer?.tallyLedgerName || '').trim() || invoice.customer?.name || 'Customer'
  const partyGstin = (invoice.customer?.gstin || '').trim()
  if (!partyGstin) warnings.push(`Customer "${party}" has no GSTIN — Tally will book the sale without a GST registration.`)

  const grandTotal = round2(invoice.grandTotal)
  const subtotal = round2(invoice.subtotal)
  const cgst = round2(invoice.cgst || 0)
  const sgst = round2(invoice.sgst || 0)
  const igst = round2(invoice.igst || 0)
  const cess = round2(invoice.cess || 0)
  const freight = round2(invoice.freightCharge || 0)
  const packing = round2(invoice.packingCharge || 0)

  // One inventory line per invoice line. Tally recomputes AMOUNT from RATE x QTY,
  // so when those disagree the billed amount wins and the qty is back-solved.
  const rows = invoice.items || []
  const items: TallyItemLine[] = rows.map((it) => {
    const rate = Number(it.rate) || 0
    const qty = Number(it.qty) || 0
    let amount = round2(Number(it.amount) || (qty ? qty * rate : 0))
    let quantity = qty
    if (rate > 0 && Math.abs(quantity * rate - amount) >= 0.01) quantity = amount / rate
    if (!Number.isFinite(amount)) amount = 0
    if (rate > 0) amount = round2(quantity * rate)
    return {
      stockItem: (it.itemName || it.description || 'Sales').trim(),
      description: (it.description || '').trim(),
      hsn: (it.hsn || '').trim(),
      quantity: Math.round(quantity * 1000) / 1000,
      unit: (it.uom || 'Nos').trim(),
      rate: round2(rate),
      amount,
      salesLedger: ledgers.sales,
    }
  })
  if (!items.length) warnings.push('Invoice has no lines — it will import as a ledger-only voucher.')
  const itemsGivenHsn = items.filter((i) => i.hsn).length
  if (items.length && itemsGivenHsn < items.length) {
    warnings.push(`${items.length - itemsGivenHsn} line(s) have no HSN/SAC — Tally falls back to the stock item master.`)
  }
  const stockValue = round2(items.reduce((s, i) => s + i.amount, 0))

  // Credit side: everything except the party. In item mode the sales value already
  // rides on each inventory line, so it must not appear a second time.
  const itemMode = items.length > 0
  const credits: TallyEntry[] = [
    ...(itemMode ? [] : [{ ledger: ledgers.sales, amount: subtotal, isParty: false, isDebit: false }]),
    { ledger: ledgers.cgst, amount: cgst, isParty: false, isDebit: false },
    { ledger: ledgers.sgst, amount: sgst, isParty: false, isDebit: false },
    { ledger: ledgers.igst, amount: igst, isParty: false, isDebit: false },
    { ledger: ledgers.cess, amount: cess, isParty: false, isDebit: false },
    { ledger: ledgers.freight, amount: round2(freight + packing), isParty: false, isDebit: false },
  ].filter((e) => e.amount > 0)

  const creditTotal = round2(credits.reduce((s, e) => s + e.amount, 0) + (itemMode ? stockValue : 0))
  const residual = round2(grandTotal - creditTotal)
  if (Math.abs(residual) >= 0.01) {
    credits.push({ ledger: ledgers.roundOff, amount: residual, isParty: false, isDebit: false })
    const explained = round2((invoice.roundOff || 0) + (subtotal - round2(rows.reduce((s, i) => s + (Number(i.amount) || 0), 0))))
    if (Math.abs(residual - explained) > 0.5) {
      warnings.push(`Voucher balances with a ${residual > 0 ? 'credit' : 'debit'} of ₹${Math.abs(residual).toFixed(2)} on "${ledgers.roundOff}" — check the invoice totals.`)
    }
  }

  const entries: TallyEntry[] = [
    { ledger: party, amount: grandTotal, isParty: true, isDebit: true, billRef: invoice.number },
    ...credits,
  ]

  if (invoice.reverseCharge) warnings.push('Reverse charge is set on the invoice — the recipient pays the GST, so the tax ledgers may need a RCM adjustment in Tally.')

  return {
    voucherType: 'Sales',
    voucherNumber: invoice.number,
    remoteId: `MANUFLOW-INV-${invoice.id}`,
    date,
    dateISO: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`,
    party,
    partyGstin,
    company: (company.name || '').trim() || null,
    gstin: {
      seller: (company.gstin || '').trim(),
      buyer: partyGstin,
      placeOfSupply: (invoice.placeOfSupply || '').trim(),
    },
    references: { order: invoice.salesOrder?.number || '', po: invoice.customerPoNo || '' },
    eInvoice: { irn: (invoice.irn || '').trim(), eWayBillNo: (invoice.ewayBillNo || '').trim() },
    flags: {
      reverseCharge: !!invoice.reverseCharge,
      docType,
      currency: invoice.currency || 'INR',
      fxRate: invoice.fxRate || 1,
    },
    items,
    entries,
    subtotal: stockValue || subtotal,
    grandTotal,
    warnings,
  }
}

const ENTRY_TAG = 'LEDGERENTRIES.LIST'

const xmlLedgerEntry = (e: TallyEntry) => `
            <${ENTRY_TAG}>
              <LEDGERNAME>${tallyText(e.ledger)}</LEDGERNAME>
              <GSTCLASS/>
              <ISDEEMEDPOSITIVE>${e.isDebit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>
              <LEDGERFROMITEM>No</LEDGERFROMITEM>
              <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>
              <ISPARTYLEDGER>${e.isParty ? 'Yes' : 'No'}</ISPARTYLEDGER>
              <ISLASTDEEMEDPOSITIVE>${e.isDebit ? 'Yes' : 'No'}</ISLASTDEEMEDPOSITIVE>
              <AMOUNT>${(e.isDebit ? -e.amount : e.amount).toFixed(2)}</AMOUNT>${e.billRef ? `
              <BILLALLOCATIONS.LIST>
                <NAME>${tallyText(e.billRef)}</NAME>
                <BILLTYPE>New Ref</BILLTYPE>
                <AMOUNT>${(e.isDebit ? -e.amount : e.amount).toFixed(2)}</AMOUNT>
              </BILLALLOCATIONS.LIST>` : ''}
            </${ENTRY_TAG}>`

/** Sales vouchers credit the stock item, purchase vouchers debit it. */
const xmlInventoryEntry = (line: TallyItemLine, debit = false) => `
            <ALLINVENTORYENTRIES.LIST>
              <STOCKITEMNAME>${tallyText(line.stockItem)}</STOCKITEMNAME>
              <ISDEEMEDPOSITIVE>${debit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>
              <ISLASTDEEMEDPOSITIVE>${debit ? 'Yes' : 'No'}</ISLASTDEEMEDPOSITIVE>
              <ISAUTONEGATE>No</ISAUTONEGATE>
              <RATE>${line.rate.toFixed(2)}/${tallyText(line.unit)}</RATE>
              <ACTUALQTY>${line.quantity.toFixed(3)} ${tallyText(line.unit)}</ACTUALQTY>
              <BILLEDQTY>${line.quantity.toFixed(3)} ${tallyText(line.unit)}</BILLEDQTY>
              <AMOUNT>${line.amount.toFixed(2)}</AMOUNT>${line.description ? `
              <BASICUSERDESCRIPTION.LIST>
                <BASICUSERDESCRIPTION>${tallyText(line.description)}</BASICUSERDESCRIPTION>
              </BASICUSERDESCRIPTION.LIST>` : ''}
              <ACCOUNTINGALLOCATIONS.LIST>
                <LEDGERNAME>${tallyText(line.salesLedger)}</LEDGERNAME>
                <GSTCLASS/>
                <ISDEEMEDPOSITIVE>${debit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>
                <LEDGERFROMITEM>No</LEDGERFROMITEM>
                <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>
                <ISPARTYLEDGER>No</ISPARTYLEDGER>
                <AMOUNT>${line.amount.toFixed(2)}</AMOUNT>
              </ACCOUNTINGALLOCATIONS.LIST>
            </ALLINVENTORYENTRIES.LIST>`

/**
 * TallyPrime import XML. Tag order and the mandatory set mirror what TallyPrime
 * itself emits when exporting a sales voucher — its importer is far stricter
 * about this than a plain XML parser.
 */
export function voucherToXml(voucher: TallyVoucher, tallyCompanyName?: string | null): string {
  // 'Sales' and 'Purchase' share one import envelope; only the type name and the side the entries post to differ.
  const vchType = (voucher.voucherType || 'Sales').trim() || 'Sales'
  const purchase = /^purchase/i.test(vchType)
  const narration = [voucher.voucherNumber, voucher.references.order ? `Against Order: ${voucher.references.order}` : '', voucher.references.po ? `Customer PO: ${voucher.references.po}` : '']
    .filter(Boolean).join(' | ')
  const itemNarration = voucher.items.map((i) => `${i.stockItem} ${i.quantity} ${i.unit} @ ${i.rate}`).join('; ')

  const irnBlock = voucher.eInvoice.irn ? `
            <IRNNO>${tallyText(voucher.eInvoice.irn)}</IRNNO>` : ''
  const ewayBlock = voucher.eInvoice.eWayBillNo ? `
            <EWAYBILLDETAILS.LIST>
              <EWAYBILLNO>${tallyText(voucher.eInvoice.eWayBillNo)}</EWAYBILLNO>
            </EWAYBILLDETAILS.LIST>` : ''
  const companyBlock = tallyCompanyName
    ? `
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${tallyText(tallyCompanyName)}</SVCURRENTCOMPANY>
        </STATICVARIABLES>`
    : ''

  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>${companyBlock}
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER REMOTEID="${tallyText(voucher.remoteId)}" VCHTYPE="${tallyText(vchType)}" ACTION="Create" OBJVIEW="Invoice Voucher View">
            <DATE>${voucher.date}</DATE>
            <EFFECTIVEDATE>${voucher.date}</EFFECTIVEDATE>
            <VOUCHERTYPENAME>${tallyText(vchType)}</VOUCHERTYPENAME>
            <VOUCHERNUMBER>${tallyText(voucher.voucherNumber)}</VOUCHERNUMBER>
            <REFERENCE>${tallyText(voucher.voucherNumber)}</REFERENCE>
            <REFERENCEDATE>${voucher.date}</REFERENCEDATE>
            <NARRATION>${tallyText(narration + (itemNarration ? ' | Items: ' + itemNarration : ''))}</NARRATION>
            <PARTYLEDGERNAME>${tallyText(voucher.party)}</PARTYLEDGERNAME>
            <PARTYNAME>${tallyText(voucher.party)}</PARTYNAME>
            <BASICBASEPARTYNAME>${tallyText(voucher.party)}</BASICBASEPARTYNAME>
            <PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW>
            <ISINVOICE>Yes</ISINVOICE>
            <ISDELETED>No</ISDELETED>
            <ISOPTIONAL>No</ISOPTIONAL>
            <ISCANCELLED>No</ISCANCELLED>
            <HASCASHFLOW>No</HASCASHFLOW>
            <DIFFACTUALQTY>No</DIFFACTUALQTY>
            <ASORIGINAL>No</ASORIGINAL>${irnBlock}${ewayBlock}${voucher.entries.map(xmlLedgerEntry).join('')}${voucher.items.map((i) => xmlInventoryEntry(i, purchase)).join('')}
          </VOUCHER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`
}

/** File name for a download: the invoice number with '/' replaced (illegal in file names). */
export function voucherFileName(number: string, ext: 'xml' | 'json' | 'xlsx'): string {
  return `${String(number || 'invoice').replace(/[\\/:*?"<>|]+/g, '-')}_tally.${ext}`
}

/** Row shape for the Excel export / for tests: one row per item then per ledger line. */
export function voucherRows(voucher: TallyVoucher): (string | number)[][] {
  const header = ['Date', 'Voucher Type', 'Voucher No', 'Party', 'Stock Item', 'Description', 'HSN/SAC', 'Qty', 'Unit', 'Rate', 'Amount', 'Ledger']
  const rows: (string | number)[][] = voucher.items.map((i) => [
    voucher.dateISO, voucher.voucherType, voucher.voucherNumber, voucher.party,
    i.stockItem, i.description, i.hsn, i.quantity, i.unit, i.rate, i.amount, i.salesLedger,
  ])
  for (const e of voucher.entries.filter((x) => !x.isParty)) {
    rows.push([voucher.dateISO, voucher.voucherType, voucher.voucherNumber, voucher.party, '', e.ledger, '', '', '', '', e.amount, e.ledger])
  }
  rows.push(['', '', '', '', '', 'GRAND TOTAL', '', '', '', '', voucher.grandTotal, ''])
  return [header, ...rows]
}
