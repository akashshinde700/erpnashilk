/**
 * Every Tally data type the Import Center lists, with what ManuFlow can actually do with it today. The UI shows this
 * as it is: nothing is labelled available unless a reader, a review and tests exist for it.
 *
 * Status meanings:
 *  - available            read from Tally and imported into ManuFlow (customers, suppliers, stock items — not listed here)
 *  - ready-for-preview    read from Tally into a review copy (Layer 1); reviewed and mapped, not imported as business data
 *  - in-development       a reader is built and tested offline but not switched on (no real TallyPrime reply checked yet)
 *  - blocked              needs something ManuFlow does not have yet (named in `needs`)
 *  - requires-configuration  works only after a setting is made (named in `needs`)
 *
 * "Verified" is separate: `verifiedLive` is true only when the request was run against a real TallyPrime and compared.
 */

export type DataTypeStatus = 'ready-for-preview' | 'in-development' | 'blocked' | 'requires-configuration'
export type DataTypeGroup = 'Masters' | 'Vouchers' | 'Stock' | 'Accounts'

export interface TallyDataType {
  key: string
  group: DataTypeGroup
  label: string
  status: DataTypeStatus
  /** Connector job that reads it (masters only, for now) */
  job?: string
  /** Layer 1 kind it is reviewed as */
  reviewKind?: string
  /** Minimum connector version for the reader */
  minConnector?: string
  verifiedLive: boolean
  /** What it gives the user today, or what is missing */
  note: string
  /** The dependencies that must exist first (empty when none) */
  needs: string[]
}

const voucher = (key: string, label: string, extra: string[] = []): TallyDataType => ({
  key, group: 'Vouchers', label, status: 'in-development', verifiedLive: false,
  note: 'Reader and staging copy are built and tested with sample files; not switched on until a real TallyPrime reply is captured and checked.',
  needs: ['Real voucher capture from the Tally test company', 'Masters reviewed (ledgers, units, godowns)', ...extra],
})

export const TALLY_DATA_TYPES: TallyDataType[] = [
  // ---- Masters: read into the review copy (Phase 1) ----
  { key: 'ledgers', group: 'Masters', label: 'Ledgers', status: 'ready-for-preview', job: 'export-ledgers', reviewKind: 'ledger', verifiedLive: false,
    note: 'Read for review: each ledger’s meaning is suggested from its Tally group; bank and cash ledgers can be linked to Cash & Bank accounts.', needs: [] },
  { key: 'groups', group: 'Masters', label: 'Ledger groups', status: 'ready-for-preview', job: 'export-groups', reviewKind: 'group', verifiedLive: false,
    note: 'Read for review; used to recognise what each ledger is.', needs: [] },
  { key: 'stockgroups', group: 'Masters', label: 'Stock groups', status: 'ready-for-preview', job: 'export-stockgroups', reviewKind: 'stockgroup', verifiedLive: false,
    note: 'Read for review; shows how many items already use each group as their category.', needs: [] },
  { key: 'units', group: 'Masters', label: 'Units', status: 'ready-for-preview', job: 'export-units', reviewKind: 'unit', verifiedLive: false,
    note: 'Read for review; compound units are flagged (ManuFlow keeps one unit per item).', needs: [] },
  { key: 'godowns', group: 'Masters', label: 'Godowns / locations', status: 'ready-for-preview', job: 'export-godowns', reviewKind: 'godown', verifiedLive: false,
    note: 'Read for review; each godown can be linked to a warehouse, or a warehouse created for it.', needs: [] },
  { key: 'costcentres', group: 'Masters', label: 'Cost centres', status: 'ready-for-preview', job: 'export-costcentres', reviewKind: 'costcentre', minConnector: '0.4.0', verifiedLive: false,
    note: 'Read for review only: ManuFlow has no cost centres yet. Needs Tally connector 0.4.0.', needs: [] },
  // ---- Vouchers (Phase 2 staging; posting needs the general ledger) ----
  voucher('sales', 'Sales'),
  voucher('purchase', 'Purchase'),
  voucher('payment', 'Payment'),
  voucher('receipt', 'Receipt'),
  voucher('contra', 'Contra'),
  voucher('journal', 'Journal', ['General ledger (ManuFlow has none yet)']),
  voucher('debit-notes', 'Debit notes'),
  voucher('credit-notes', 'Credit notes'),
  voucher('sales-orders', 'Sales orders', ['Order processing switched on in Tally']),
  voucher('purchase-orders', 'Purchase orders', ['Order processing switched on in Tally']),
  voucher('delivery-notes', 'Delivery notes'),
  voucher('receipt-notes', 'Receipt notes'),
  voucher('stock-journals', 'Stock journals'),
  // ---- Stock ----
  { key: 'opening-stock', group: 'Stock', label: 'Opening stock', status: 'requires-configuration', verifiedLive: false,
    note: 'Can be imported today from a Tally XML or Excel file (Import Center → file import), once the go-live date is set. Reading it straight from Tally is not built yet.',
    needs: ['Go-live date', 'Godowns linked to warehouses', 'Tally reader for opening quantities (not built)'] },
  { key: 'stock-movements', group: 'Stock', label: 'Stock movements', status: 'blocked', verifiedLive: false,
    note: 'Comes from inventory vouchers; kept as reference only so stock is never counted twice.', needs: ['Voucher reading (Phase 2)'] },
  { key: 'stock-summary', group: 'Stock', label: 'Stock summary / balances', status: 'blocked', verifiedLive: false,
    note: 'For reconciliation against ManuFlow stock. The Tally request has not been captured yet.', needs: ['Real capture of Tally’s stock summary', 'Godowns linked to warehouses'] },
  { key: 'closing-stock', group: 'Stock', label: 'Closing stock', status: 'blocked', verifiedLive: false,
    note: 'For reconciliation. The Tally request has not been captured yet.', needs: ['Real capture of Tally’s closing stock'] },
  // ---- Accounts ----
  { key: 'opening-balances', group: 'Accounts', label: 'Opening balances', status: 'blocked', verifiedLive: false,
    note: 'Party opening balances can be previewed from a file today, not posted: ManuFlow keeps one undated number per party that cannot be settled bill by bill.',
    needs: ['Go-live date', 'Bill-wise opening entries or the general ledger'] },
  { key: 'closing-balances', group: 'Accounts', label: 'Closing balances', status: 'blocked', verifiedLive: false,
    note: 'For reconciliation only. The Tally request has not been captured yet.', needs: ['Real capture', 'Ledgers reviewed'] },
  { key: 'ledger-balances', group: 'Accounts', label: 'Ledger balances', status: 'blocked', verifiedLive: false,
    note: 'For reconciliation only. The Tally request has not been captured yet.', needs: ['Real capture', 'Ledgers reviewed'] },
  { key: 'trial-balance', group: 'Accounts', label: 'Trial balance', status: 'blocked', verifiedLive: false,
    note: 'For reconciliation; ManuFlow’s own trial balance is worked out from documents (no general ledger yet).', needs: ['Real capture of Tally’s trial balance', 'General ledger'] },
  { key: 'outstanding-receivables', group: 'Accounts', label: 'Outstanding receivables', status: 'blocked', verifiedLive: false,
    note: 'Source of opening bills at go-live and for reconciliation. Not captured yet.', needs: ['Real capture of bill-wise outstandings', 'Bill-wise opening entries'] },
  { key: 'outstanding-payables', group: 'Accounts', label: 'Outstanding payables', status: 'blocked', verifiedLive: false,
    note: 'Source of opening bills at go-live and for reconciliation. Not captured yet.', needs: ['Real capture of bill-wise outstandings', 'Bill-wise opening entries'] },
]

export const STATUS_LABEL: Record<DataTypeStatus, string> = {
  'ready-for-preview': 'Ready for preview',
  'in-development': 'In development',
  blocked: 'Blocked by dependency',
  'requires-configuration': 'Requires configuration',
}

export const MASTER_TYPES = TALLY_DATA_TYPES.filter((t) => t.status === 'ready-for-preview')
