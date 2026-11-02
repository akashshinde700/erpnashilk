import { ApiError } from '@/lib/erp-helpers'
import { VYAPAR_UNITS, vyaparPhone, type VyaparFirm, type VyaparItem, type VyaparMoneyAccount, type VyaparParty, type VyaparSnapshot, type VyaparTxnGroup } from '@/lib/vyapar/shared'
import { openSqlite, SqliteError, type SqliteValue } from '@/lib/vyapar/sqlite'
import { isZip, readZipEntries, ZipError, zipEntryNames } from '@/lib/vyapar/zip'

/**
 * Read a Vyapar backup and turn it into the facts the Import Center shows the user.
 *
 * A Vyapar backup is either
 *   - `.vyb`: a ZIP that holds one `.vyp` file per Vyapar company, or
 *   - `.vyp`: the company's SQLite database on its own.
 *
 * Nothing here writes to the database and nothing is trusted: every table is looked up by name and
 * every column is read through the header of the file itself, so a backup from a different Vyapar
 * version works as long as the tables exist. A missing table is reported, never guessed.
 *
 * What a backup holds (Vyapar's own table names):
 *   kb_firms         the company (name, GSTIN, state, address, bank)
 *   kb_names         parties — name_type 1 = customer (Vyapar calls them "Customers"), 2 = supplier
 *   kb_items         items — prices, GST rate, HSN, unit, current stock quantity and value
 *   kb_item_units    units (NUMBERS, KILOGRAMS …)
 *   kb_tax_code      GST rates behind an item's tax id
 *   kb_transactions  vouchers (sale 1, purchase 2, payment in 3, payment out 4, opening 5/6, expense 7)
 *   kb_paymentTypes  cash / bank / cheque accounts with their opening balances
 */

export const VYAPAR_LIMITS = {
  /** Upload cap for a backup file (bytes). A Vyapar backup of a small business is a few MB. */
  maxFileBytes: 256 * 1024 * 1024,
  maxParties: 100_000,
  maxItems: 200_000,
} as const

export type {
  VyaparFirm, VyaparItem, VyaparMoneyAccount, VyaparParty, VyaparPartyKind, VyaparSnapshot, VyaparSnapshotStats, VyaparTxnGroup,
} from '@/lib/vyapar/shared'
export { VYAPAR_UNITS } from '@/lib/vyapar/shared'

const str = (v: SqliteValue | undefined): string => (v === null || v === undefined ? '' : String(v)).trim()
const num = (v: SqliteValue | undefined): number => {
  if (v === null || v === undefined || v === '') return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const numOrNull = (v: SqliteValue | undefined): number | null => (v === null || v === undefined || v === '' ? null : num(v))
/** Round to 2 decimals (money) without float noise in the JSON sent to the browser. */
const r2 = (n: number) => Math.round(n * 100) / 100

/** Vyapar transaction types we can name without guessing (their own constants). */
const TXN_LABELS: Record<number, string> = {
  1: 'Sales invoices',
  2: 'Purchase bills',
  3: 'Payments received',
  4: 'Payments made',
  5: 'Party opening balances (to receive)',
  6: 'Party opening balances (to pay)',
  7: 'Expenses',
  31: 'Payment opening balances (in)',
  32: 'Payment opening balances (out)',
}

const OTHER_TXN = 'Other vouchers'

export interface VyaparRead {
  snapshot: VyaparSnapshot
  /** Files seen inside the backup (for the UI / audit trail). */
  parts: string[]
}

/** Open the uploaded file (a `.vyb` ZIP or a bare `.vyp` database) and read the company data. */
export function readVyaparBackup(buf: Buffer, fileName: string): VyaparRead {
  try {
    return readBackup(buf, fileName)
  } catch (e) {
    // The readers' own messages are written for the user — never let them surface as a 500
    if (e instanceof SqliteError || e instanceof ZipError) throw new ApiError(e.message, 400)
    throw e
  }
}

function readBackup(buf: Buffer, fileName: string): VyaparRead {
  if (!buf.length) throw new ApiError('The backup file is empty', 400)
  let parts: string[] = [fileName]
  let companyFile = fileName
  let db: Buffer
  if (isZip(buf)) {
    parts = zipEntryNames(buf)
    const vypNames = parts.filter((n) => n.toLowerCase().endsWith('.vyp'))
    if (!vypNames.length) {
      throw new ApiError('This ZIP is not a Vyapar backup — a .vyb file holds a .vyp company file inside. Export the backup again from Vyapar (Settings → Backup).', 400)
    }
    // A backup of one company is the normal case; with several, the biggest company file is used and
    // said so — the user must not silently get another company's data.
    const entries = readZipEntries(buf, (n) => n.toLowerCase().endsWith('.vyp'))
    if (!entries.length) throw new ApiError('The backup has no readable company file', 400)
    entries.sort((a, b) => b.data.length - a.data.length)
    companyFile = entries[0].name
    db = entries[0].data
  } else {
    db = buf
  }
  if (db.length < 512 || db.toString('latin1', 0, 16) !== 'SQLite format 3\u0000') {
    throw new ApiError('This is not a Vyapar backup — upload the .vyb file Vyapar creates, or the .vyp company file inside it.', 400)
  }
  const file = openSqlite(db)
  const data = readCompany(file, { fileName, fileSize: buf.length, parts, companyFile })
  return { snapshot: data, parts }
}

function readCompany(file: ReturnType<typeof openSqlite>, source: VyaparSnapshot['source']): VyaparSnapshot {
  for (const table of ['kb_firms', 'kb_names', 'kb_items']) {
    if (!file.hasTable(table)) {
      throw new ApiError(
        'This database is not a Vyapar company file (its tables are missing) — take the backup again from Vyapar and upload the .vyb file.',
        400,
      )
    }
  }
  const warnings: string[] = []
  const firms = file.records('kb_firms')
  if (!firms.length) throw new ApiError('The backup holds no company (Vyapar firm) — nothing to import', 400)
  if (firms.length > 1) warnings.push(`The backup holds ${firms.length} firms; the first one is read.`)

  const firmRow = firms[0]
  const firm: VyaparFirm = {
    name: str(firmRow.firm_name),
    gstin: str(firmRow.firm_gstin_number).toUpperCase(),
    state: str(firmRow.firm_state),
    phone: str(firmRow.firm_phone),
    email: str(firmRow.firm_email),
    address: str(firmRow.firm_address),
    pincode: str(firmRow.firm_pincode),
    bankName: str(firmRow.firm_bank_name),
    bankAccountNo: str(firmRow.firm_bank_account_number),
    bankIfsc: str(firmRow.firm_bank_ifsc_code),
  }

  // ---- units + GST rates (both optional tables: a very old backup may not have them)
  const unitById = new Map<number, string>()
  if (file.hasTable('kb_item_units')) {
    for (const u of file.records('kb_item_units')) unitById.set(num(u.unit_id), str(u.unit_name))
  }
  const taxById = new Map<number, number>()
  if (file.hasTable('kb_tax_code')) {
    for (const t of file.records('kb_tax_code')) taxById.set(num(t.tax_code_id), num(t.tax_rate))
  }
  const categoryById = new Map<number, string>()
  if (file.hasTable('kb_item_categories')) {
    for (const c of file.records('kb_item_categories')) categoryById.set(num(c.category_id), str(c.category_name))
  }

  // ---- parties
  const parties: VyaparParty[] = []
  for (const p of file.records('kb_names')) {
    const kindCode = num(p.name_type)
    if (kindCode !== 1 && kindCode !== 2) continue
    const name = str(p.full_name)
    if (!name) continue
    parties.push({
      id: num(p.name_id),
      kind: kindCode === 1 ? 'customer' : 'supplier',
      name,
      phone: str(p.phone_number),
      email: str(p.email),
      gstin: str(p.name_gstin_number).toUpperCase(),
      state: str(p.name_state),
      address: str(p.address),
      pincode: str(p.pincode),
      balance: r2(num(p.amount)),
      creditLimit: r2(num(p.credit_limit)),
      active: num(p.name_is_active) !== 0,
    })
    if (parties.length > VYAPAR_LIMITS.maxParties) throw new ApiError('This backup has too many parties to import in one go', 400)
  }

  // ---- items
  const items: VyaparItem[] = []
  const unknownUnitCount = new Map<string, number>()
  for (const i of file.records('kb_items')) {
    const name = str(i.item_name)
    if (!name) continue
    const unitRaw = unitById.get(num(i.base_unit_id)) ?? ''
    const gstId = numOrNull(i.item_tax_id)
    const taxRate = gstId === null ? null : taxById.get(gstId) ?? null
    items.push({
      id: num(i.item_id),
      name,
      code: str(i.item_code),
      unit: unitRaw,
      hsn: str(i.item_hsn_sac_code),
      gstRate: taxRate,
      salePrice: r2(num(i.item_sale_unit_price)),
      purchasePrice: r2(num(i.item_purchase_unit_price)),
      mrp: numOrNull(i.item_mrp),
      category: categoryById.get(num(i.category_id)) ?? '',
      stockQty: Math.round(num(i.item_stock_quantity) * 1000) / 1000,
      stockValue: r2(num(i.item_stock_value)),
      service: num(i.item_type) === 2,
      description: str(i.item_description),
      active: num(i.item_is_active) !== 0,
    })
    if (items.length > VYAPAR_LIMITS.maxItems) throw new ApiError('This backup has too many items to import in one go', 400)
    const mapped = VYAPAR_UNITS[unitRaw.toUpperCase()]
    if (!mapped) unknownUnitCount.set(unitRaw || '(no unit)', (unknownUnitCount.get(unitRaw || '(no unit)') ?? 0) + 1)
  }
  const unknownUnits = [...unknownUnitCount.entries()]
    .map(([unit, count]) => ({ unit, count }))
    .sort((a, b) => b.count - a.count)

  // ---- transactions: only counts, date range and a label per type (nothing is imported)
  const txnGroups = new Map<number, { count: number; from: string; to: string }>()
  let firstTxnDate = ''
  let lastTxnDate = ''
  let transactions = 0
  if (file.hasTable('kb_transactions')) {
    for (const t of file.records('kb_transactions')) {
      const date = str(t.txn_date).slice(0, 10)
      const type = num(t.txn_type)
      transactions++
      if (date) {
        if (!firstTxnDate || date < firstTxnDate) firstTxnDate = date
        if (!lastTxnDate || date > lastTxnDate) lastTxnDate = date
      }
      const g = txnGroups.get(type) ?? { count: 0, from: date, to: date }
      g.count++
      if (date) {
        if (!g.from || date < g.from) g.from = date
        if (!g.to || date > g.to) g.to = date
      }
      txnGroups.set(type, g)
    }
  }
  const groups: VyaparTxnGroup[] = [...txnGroups.entries()]
    .map(([type, g]) => ({ type, label: TXN_LABELS[type] ?? `${OTHER_TXN} (type ${type})`, count: g.count, from: g.from, to: g.to }))
    .sort((a, b) => b.count - a.count)

  // ---- cash / bank accounts with their opening balances (shown for the go-live comparison)
  const moneyAccounts: VyaparMoneyAccount[] = []
  if (file.hasTable('kb_paymentTypes')) {
    for (const a of file.records('kb_paymentTypes')) {
      const kind = str(a.paymentType_type).toUpperCase()
      moneyAccounts.push({
        name: str(a.paymentType_name) || kind,
        kind: kind === 'BANK' ? 'BANK' : kind === 'CHEQUE' ? 'CHEQUE' : kind === 'CASH' ? 'CASH' : 'ONLINE',
        openingBalance: r2(num(a.paymentType_opening_balance)),
        openingDate: str(a.paymentType_opening_date).slice(0, 10),
      })
    }
  }

  const customers = parties.filter((p) => p.kind === 'customer')
  const suppliers = parties.filter((p) => p.kind === 'supplier')
  const withStock = items.filter((i) => i.stockQty > 0)
  const snapshot: VyaparSnapshot = {
    source,
    firm,
    parties,
    items,
    stats: {
      parties: parties.length,
      customers: customers.length,
      suppliers: suppliers.length,
      inactiveParties: parties.filter((p) => !p.active).length,
      partiesWithGstin: parties.filter((p) => p.gstin).length,
      receivable: r2(customers.reduce((s, p) => s + p.balance, 0)),
      payable: r2(suppliers.reduce((s, p) => s + p.balance, 0)),
      items: items.length,
      serviceItems: items.filter((i) => i.service).length,
      itemsWithStock: withStock.length,
      stockQty: Math.round(withStock.reduce((s, i) => s + i.stockQty, 0) * 1000) / 1000,
      stockValue: r2(withStock.reduce((s, i) => s + i.stockValue, 0)),
      itemsWithoutGst: items.filter((i) => i.gstRate === null).length,
      itemsWithoutHsn: items.filter((i) => !i.hsn).length,
      itemsWithCode: items.filter((i) => i.code).length,
      partiesWithoutValidPhone: parties.filter((p) => p.phone && !vyaparPhone(p.phone)).length,
      transactions,
      txnGroups: groups,
      firstTxnDate,
      lastTxnDate,
      moneyAccounts,
    },
    unknownUnits,
    warnings,
  }

  if (!customers.length) warnings.push('The backup has no customers.')
  if (!suppliers.length) warnings.push('The backup has no suppliers.')
  if (!items.length) warnings.push('The backup has no items.')
  if (snapshot.stats.partiesWithoutValidPhone) {
    warnings.push(`${snapshot.stats.partiesWithoutValidPhone} parties have a phone number that is not a 10-digit Indian number — they are imported without a phone.`)
  }
  if (snapshot.stats.itemsWithoutGst) {
    warnings.push(`${snapshot.stats.itemsWithoutGst} items have no GST rate in Vyapar — choose a rate for them before importing.`)
  }
  if (unknownUnits.length) {
    const list = unknownUnits.slice(0, 4).map((u) => `${u.unit} (${u.count})`).join(', ')
    warnings.push(`${unknownUnits.reduce((s, u) => s + u.count, 0)} items use a unit ManuFlow does not have: ${list}${unknownUnits.length > 4 ? '…' : ''} — choose a fallback unit.`)
  }
  if (transactions) {
    warnings.push('Vouchers (sales, purchases, payments, expenses) are read for the summary only — they are not imported yet.')
  }
  return snapshot
}
