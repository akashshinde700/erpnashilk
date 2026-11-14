/**
 * Pure parts of the Tally masters review (no database): the ledger classifier built on Tally's predefined groups, and
 * the shapes the review API returns. Safe to import from the browser.
 */

export const REVIEW_KINDS = ['group', 'ledger', 'stockgroup', 'unit', 'godown', 'costcentre'] as const
export type ReviewKind = (typeof REVIEW_KINDS)[number]

// ---------------------------------------------------------------- ledger classification (pure)

export const LEDGER_CATEGORIES = [
  'customer', 'supplier', 'bank', 'cash', 'sales', 'purchase', 'expense', 'income', 'tax', 'capital', 'loan', 'asset', 'liability',
  'suspense', 'branch', 'unknown',
] as const
export type LedgerCategory = (typeof LEDGER_CATEGORIES)[number]

export const LEDGER_CATEGORY_LABEL: Record<LedgerCategory, string> = {
  customer: 'Customer (Sundry Debtors)', supplier: 'Supplier (Sundry Creditors)', bank: 'Bank account', cash: 'Cash account',
  sales: 'Sales account', purchase: 'Purchase account', expense: 'Expense', income: 'Income', tax: 'Duties & taxes',
  capital: 'Capital / reserves', loan: 'Loan (liability)', asset: 'Asset', liability: 'Liability / provision',
  suspense: 'Suspense', branch: 'Branch / division', unknown: 'Not recognised',
}

/**
 * Tally's predefined (reserved) groups → meaning. `sure`: the group alone says what a ledger under it is; otherwise the
 * group is too broad (e.g. a ledger directly under Current Assets) and the suggestion needs review.
 * Names as TallyPrime ships them; a renamed predefined group is recognised by its RESERVEDNAME (connector 0.4.0+).
 */
const RESERVED: Record<string, { category: LedgerCategory; sure: boolean }> = {
  'sundry debtors': { category: 'customer', sure: true },
  'sundry creditors': { category: 'supplier', sure: true },
  'bank accounts': { category: 'bank', sure: true },
  'bank od a/c': { category: 'bank', sure: true },
  'cash-in-hand': { category: 'cash', sure: true },
  'sales accounts': { category: 'sales', sure: true },
  'purchase accounts': { category: 'purchase', sure: true },
  'direct expenses': { category: 'expense', sure: true },
  'indirect expenses': { category: 'expense', sure: true },
  'direct incomes': { category: 'income', sure: true },
  'indirect incomes': { category: 'income', sure: true },
  'duties & taxes': { category: 'tax', sure: true },
  'capital account': { category: 'capital', sure: true },
  'reserves & surplus': { category: 'capital', sure: true },
  'loans (liability)': { category: 'loan', sure: true },
  'secured loans': { category: 'loan', sure: true },
  'unsecured loans': { category: 'loan', sure: true },
  'fixed assets': { category: 'asset', sure: true },
  'investments': { category: 'asset', sure: true },
  'deposits (asset)': { category: 'asset', sure: true },
  'loans & advances (asset)': { category: 'asset', sure: true },
  'stock-in-hand': { category: 'asset', sure: true },
  'misc. expenses (asset)': { category: 'asset', sure: true },
  'provisions': { category: 'liability', sure: true },
  // broad primary groups: what a ledger directly under them is cannot be told from the group
  'current assets': { category: 'asset', sure: false },
  'current liabilities': { category: 'liability', sure: false },
  'suspense a/c': { category: 'suspense', sure: false },
  'branch / divisions': { category: 'branch', sure: false },
}
const key = (s: string | null | undefined) => (s ?? '').trim().toLowerCase()

export interface GroupInfo { name: string; parent: string | null; reservedName?: string | null }
export interface LedgerClass {
  category: LedgerCategory
  /** exact: a predefined group decides it; review: a person must confirm it (broad group, or not recognised) */
  confidence: 'exact' | 'review'
  /** The predefined group that decided it, as Tally names it today (null when none was found) */
  via: string | null
  /** Group path from the ledger's parent up to that predefined group (or as far as it could be followed) */
  path: string[]
  reason: string
}

const MAX_DEPTH = 50

/**
 * Builds a classifier from the groups read from Tally. classify(parent) follows the ledger's parent group upwards
 * until a predefined group is found (by RESERVEDNAME when Tally sent it, else by its name). Loops, missing groups and
 * very deep trees end in "not recognised", never in a guess.
 */
export function ledgerClassifier(groups: GroupInfo[]) {
  const byName = new Map<string, GroupInfo>()
  for (const g of groups) byName.set(key(g.name), g)
  return function classify(parent: string | null | undefined): LedgerClass {
    const path: string[] = []
    const seen = new Set<string>()
    let current = parent?.trim() || ''
    if (!current || key(current) === 'primary') {
      return { category: 'unknown', confidence: 'review', via: null, path, reason: 'The ledger has no parent group in Tally (for example the Profit & Loss ledger).' }
    }
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      const k = key(current)
      if (seen.has(k)) return { category: 'unknown', confidence: 'review', via: null, path, reason: 'The group tree read from Tally loops back on itself.' }
      seen.add(k)
      path.push(current)
      const g = byName.get(k)
      const hit = RESERVED[key(g?.reservedName)] ?? RESERVED[k]
      if (hit) {
        return {
          category: hit.category, confidence: hit.sure ? 'exact' : 'review', via: current, path,
          reason: hit.sure ? `Under Tally's “${current}” group.` : `Directly under Tally's broad “${current}” group — confirm what this ledger is.`,
        }
      }
      if (!g) return { category: 'unknown', confidence: 'review', via: null, path, reason: `The group “${current}” was not found among the groups read from Tally — read Ledger groups too.` }
      const up = g.parent?.trim() || ''
      if (!up || key(up) === 'primary') return { category: 'unknown', confidence: 'review', via: null, path, reason: `“${current}” is a group created in Tally at the top level; its meaning cannot be told.` }
      current = up
    }
    return { category: 'unknown', confidence: 'review', via: null, path, reason: 'The group tree is too deep to follow.' }
  }
}

/** A unit needs review when it is compound (e.g. "Box of 10 Nos"): ManuFlow keeps one unit text per item. */
export function unitNeedsReview(d: Record<string, unknown>): boolean {
  return String(d.isSimple ?? '').toLowerCase() === 'no' || !!d.baseUnits || !!d.additionalUnits
}

export interface ReviewRow {
  guid: string
  name: string
  parent: string | null
  alterId: number | null
  data: Record<string, unknown>
  issues: { code: string; message: string }[]
  missingSince: string | null
  lastSeenAt: string
  /** ledgers only */
  classification?: LedgerClass
  /** ManuFlow record this master is linked to (godown → warehouse; ledger → customer / supplier / cash-bank account) */
  link?: { kind: string; id: string; label: string } | null
  /** godowns: a warehouse with the same name (a suggestion only; nothing is linked until the user does it) */
  suggestion?: { id: string; label: string } | null
  /** units / stock groups: ManuFlow items already using this unit / category text */
  itemsUsing?: number
  needsReview: boolean
}

export interface KindSummary { kind: ReviewKind; total: number; withIssues: number; missing: number; needsReview: number; linked: number; lastReadAt: string | null }

export type ReviewFilter = 'all' | 'review' | 'issues' | 'missing' | 'linked' | 'unlinked'
export const REVIEW_PAGE = 100
