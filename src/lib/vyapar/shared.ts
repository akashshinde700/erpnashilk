/**
 * Vyapar backup types + the unit map, shared by the server reader (backup.ts), the import mapping
 * (to-import.ts) and the Import Center UI (vyapar-backup.tsx). Client-safe: no Node or DB imports.
 */

export type VyaparPartyKind = 'customer' | 'supplier'

export interface VyaparFirm {
  name: string
  gstin: string
  state: string
  phone: string
  email: string
  address: string
  pincode: string
  bankName: string
  bankAccountNo: string
  bankIfsc: string
}

export interface VyaparParty {
  id: number
  kind: VyaparPartyKind
  name: string
  phone: string
  email: string
  gstin: string
  state: string
  address: string
  pincode: string
  /** Vyapar's own balance for the party (positive = to receive for a customer / to pay for a supplier). */
  balance: number
  creditLimit: number
  active: boolean
}

export interface VyaparItem {
  id: number
  name: string
  code: string
  /** Unit as Vyapar has it (e.g. KILOGRAMS) — mapped to a ManuFlow unit by to-import.ts. */
  unit: string
  hsn: string
  gstRate: number | null
  salePrice: number
  purchasePrice: number
  mrp: number | null
  category: string
  stockQty: number
  stockValue: number
  /** Vyapar item_type: 1 = product, 2 = service (also used for expense-type items). */
  service: boolean
  description: string
  active: boolean
}

export interface VyaparTxnGroup {
  type: number
  label: string
  count: number
  from: string
  to: string
}

export interface VyaparMoneyAccount {
  name: string
  kind: 'CASH' | 'BANK' | 'CHEQUE' | 'ONLINE'
  openingBalance: number
  openingDate: string
}

export interface VyaparSnapshotStats {
  parties: number
  customers: number
  suppliers: number
  inactiveParties: number
  partiesWithGstin: number
  receivable: number
  payable: number
  items: number
  serviceItems: number
  itemsWithStock: number
  stockQty: number
  stockValue: number
  itemsWithoutGst: number
  itemsWithoutHsn: number
  itemsWithCode: number
  /** Parties whose phone number is not a 10-digit Indian number (imported without it). */
  partiesWithoutValidPhone: number
  transactions: number
  txnGroups: VyaparTxnGroup[]
  firstTxnDate: string
  lastTxnDate: string
  moneyAccounts: VyaparMoneyAccount[]
}

export interface VyaparSnapshot {
  source: {
    fileName: string
    fileSize: number
    /** Names of the files inside the backup (one .vyp per company) — shown so the user can check. */
    parts: string[]
    companyFile: string
  }
  firm: VyaparFirm
  parties: VyaparParty[]
  items: VyaparItem[]
  stats: VyaparSnapshotStats
  /** Units in the backup that have no ManuFlow equivalent, biggest first (the user picks a fallback). */
  unknownUnits: { unit: string; count: number }[]
  warnings: string[]
}

/** What POST /api/import-center/vyapar/inspect returns: the summary, plus a short sample. */
export interface VyaparSnapshotView extends Omit<VyaparSnapshot, 'parties' | 'items'> {
  snapshotId: string
  sample: { parties: VyaparParty[]; items: VyaparItem[] }
  /** Rows each data type will produce (after skipping inactive parties / items). */
  lists: { customers: number; suppliers: number; items: number; openingStock: number }
}

/**
 * Vyapar phone → the 10-digit number ManuFlow validates, or null when the digits do not make one.
 * Vyapar users often type 12-digit numbers with 91, or 11 with a leading 0 — those are cleaned up;
 * anything else is left out rather than blocking the whole party (the flow reports how many).
 */
export function vyaparPhone(raw: string): string | null {
  const digits = String(raw ?? '').replace(/\D/g, '')
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2)
  if (digits.length === 13 && digits.startsWith('091')) return digits.slice(3)
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1)
  return digits.length === 10 ? digits : null
}

/**
 * Vyapar unit name → ManuFlow unit code. Anything not here goes to the user's fallback unit
 * (the Import Center asks for one when the backup has such items).
 */
export const VYAPAR_UNITS: Record<string, string> = {
  NUMBERS: 'NOS', NUMBER: 'NOS', NOS: 'NOS', NO: 'NOS', EA: 'NOS', UNIT: 'NOS', UNITS: 'NOS', SERVICE: 'NOS',
  PIECES: 'PCS', PIECE: 'PCS', PCS: 'PCS', PC: 'PCS',
  KILOGRAMS: 'KG', KILOGRAM: 'KG', KG: 'KG', KGS: 'KG',
  GRAMMES: 'GM', GRAMME: 'GM', GRAMS: 'GM', GRAM: 'GM', GM: 'GM',
  LITRE: 'LTR', LITER: 'LTR', LITRES: 'LTR', LTR: 'LTR',
  METERS: 'MTR', METRES: 'MTR', METER: 'MTR', METRE: 'MTR', MTR: 'MTR',
  'SQUARE METERS': 'MTR2', SQM: 'MTR2',
  BOX: 'BOX', BOXES: 'BOX',
  SET: 'SET', SETS: 'SET',
  ROLLS: 'ROLL', ROLL: 'ROLL',
  HOUR: 'HRS', HOURS: 'HRS', HR: 'HRS', HRS: 'HRS',
}
