// ============ Shared ERP constants (client + server safe) ============

export type ItemStatus = 'ACTIVE' | 'INACTIVE'
export const ITEM_TYPES = ['RAW', 'SEMI', 'FINISHED', 'CONSUMABLE', 'SERVICE'] as const
export const ITEM_TYPE_LABEL: Record<string, string> = {
  RAW: 'Raw Material', SEMI: 'Semi-Finished', FINISHED: 'Finished Good', CONSUMABLE: 'Consumable', SERVICE: 'Service',
}

export const UOMS = ['NOS', 'PCS', 'KG', 'GM', 'LTR', 'MTR', 'MTR2', 'BOX', 'SET', 'ROLL', 'HRS'] as const

export const ROLES = ['TENANT_ADMIN', 'MANAGEMENT', 'PLANT_MANAGER', 'PRODUCTION_MANAGER', 'PRODUCTION_SUPERVISOR', 'OPERATOR', 'PURCHASE_MANAGER', 'PURCHASE_EXECUTIVE', 'SALES_MANAGER', 'SALES_EXECUTIVE', 'STORE_MANAGER', 'STORE_OPERATOR', 'QUALITY_MANAGER', 'QC_INSPECTOR', 'ACCOUNTS_MANAGER', 'ACCOUNTANT', 'MAINTENANCE_MANAGER', 'DISPATCH_MANAGER', 'VIEWER'] as const
export const ROLE_LABEL: Record<string, string> = {
  TENANT_ADMIN: 'Tenant Admin', MANAGEMENT: 'Management', PLANT_MANAGER: 'Plant Manager',
  PRODUCTION_MANAGER: 'Production Manager', PRODUCTION_SUPERVISOR: 'Production Supervisor', OPERATOR: 'Operator',
  PURCHASE_MANAGER: 'Purchase Manager', PURCHASE_EXECUTIVE: 'Purchase Executive',
  SALES_MANAGER: 'Sales Manager', SALES_EXECUTIVE: 'Sales Executive',
  STORE_MANAGER: 'Store Manager', STORE_OPERATOR: 'Store Operator',
  QUALITY_MANAGER: 'Quality Manager', QC_INSPECTOR: 'QC Inspector',
  ACCOUNTS_MANAGER: 'Accounts Manager', ACCOUNTANT: 'Accountant',
  MAINTENANCE_MANAGER: 'Maintenance Manager', DISPATCH_MANAGER: 'Dispatch Manager', VIEWER: 'Viewer',
}

// Status → badge tone
export type Tone = 'gray' | 'green' | 'amber' | 'red' | 'blue' | 'purple' | 'teal'

export const STATUS_TONE: Record<string, Tone> = {
  // generic
  ACTIVE: 'green', INACTIVE: 'gray', DRAFT: 'gray', PENDING: 'amber', PENDING_APPROVAL: 'amber',
  PENDING_QC: 'amber', APPROVED: 'green', REJECTED: 'red', CANCELLED: 'red', CLOSED: 'gray', POSTED: 'green',
  // sales / purchase docs
  OPEN: 'blue', QUOTED: 'purple', WON: 'green', LOST: 'red',
  SENT: 'blue', CONVERTED: 'teal',
  CONFIRMED: 'blue', IN_PRODUCTION: 'purple', READY: 'teal', PARTIALLY_DISPATCHED: 'amber', DISPATCHED: 'teal', COMPLETED: 'green',
  PARTIALLY_RECEIVED: 'amber', RECEIVED: 'teal', INVOICED: 'teal',
  PARTIALLY_ACCEPTED: 'amber', PASSED: 'green', FAILED: 'red', PARTIAL: 'amber',
  // payment
  UNPAID: 'red', PAID: 'green', PARTIALLY_PAID: 'amber',
  // wo
  PLANNED: 'gray', RELEASED: 'blue', NORMAL: 'gray', HIGH: 'amber', URGENT: 'red',
  // misc
  RUNNING: 'green', IDLE: 'gray', MAINTENANCE: 'amber', BREAKDOWN: 'red',
  INFO: 'blue', WARNING: 'amber', CRITICAL: 'red',
  CASH: 'gray', BANK: 'blue', UPI: 'teal', CHEQUE: 'amber', NEFT: 'purple', RTGS: 'purple',
  UTENSILS: 'gray',
}

export const PAYMENT_MODES = ['CASH', 'BANK', 'UPI', 'CHEQUE', 'NEFT', 'RTGS'] as const

/** Cash & Bank account type a payment mode must use: CASH → a cash account; every other mode → a bank account. */
export const accountTypeForMode = (mode: string | null | undefined): 'CASH' | 'BANK' => ((mode || 'CASH') === 'CASH' ? 'CASH' : 'BANK')

export interface ModeAccount { id: string; name: string; type: string; active?: boolean; isDefault?: boolean; createdAt?: string | Date }

/**
 * Account choices for a payment mode (forms): only active accounts of the mode's type, and the account the server
 * will use when none is chosen (default first, then the oldest — same order as postingAccount), or null when the
 * company has none (the server then refuses: no fallback from bank to cash).
 */
export function accountsForMode<A extends ModeAccount>(accounts: A[], mode: string | null | undefined) {
  const type = accountTypeForMode(mode)
  const matching = accounts.filter((a) => a.active !== false && a.type === type)
  const time = (a: A) => (a.createdAt ? new Date(a.createdAt).getTime() : 0)
  const fallback = [...matching].sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault) || time(a) - time(b))[0] ?? null
  return { type, matching, fallback }
}
export const EXPENSE_CATEGORIES = ['UTILITIES', 'FREIGHT', 'RENT', 'SALARY', 'MAINTENANCE', 'TOOLING', 'OTHER'] as const
export const STOCK_TYPES = ['OPENING', 'GRN_IN', 'ISSUE_OUT', 'PRODUCTION_IN', 'DISPATCH_OUT', 'TRANSFER_IN', 'TRANSFER_OUT', 'ADJUST_IN', 'ADJUST_OUT', 'RETURN_IN', 'QC_REJECT', 'SALES_RETURN', 'SALES_RETURN_IN', 'SALES_RETURN_REVERSAL', 'PURCHASE_IN', 'PURCHASE_RETURN', 'PURCHASE_RETURN_OUT', 'PURCHASE_RETURN_REVERSAL', 'BACKFLUSH_OUT'] as const

export function tone(s: string | null | undefined): Tone {
  if (!s) return 'gray'
  return STATUS_TONE[s] || 'gray'
}

export const fmtMoney = (n: number | null | undefined) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(n || 0)

export const fmtNum = (n: number | null | undefined) =>
  new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 }).format(n || 0)

export const fmtDate = (d: string | Date | null | undefined) =>
  d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'

export const fmtDateTime = (d: string | Date | null | undefined) =>
  d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'

export interface ApiResponse<T> {
  success: boolean
  data?: T
  message?: string
  error?: { code: string; message: string; details?: unknown }
}

// ============ RBAC: role → visible module keys (client-side gating) ============
// '*' = full access. Server still enforces tenant isolation; this gates navigation only.
export const ROLE_MODULE_KEYS: Record<string, string[] | '*'> = {
  TENANT_ADMIN: '*',
  MANAGEMENT: '*',
  SUPER_ADMIN: '*',
  SALES_MANAGER: ['notifications', 'dashboard', 'items', 'customers', 'enquiries', 'quotations', 'sales-orders', 'deliveries', 'sales-invoices', 'payments', 'reports', 'stock', 'sales-returns'],
  SALES_EXECUTIVE: ['notifications', 'dashboard', 'items', 'customers', 'enquiries', 'quotations', 'sales-orders', 'deliveries', 'sales-invoices', 'stock'],
  PURCHASE_MANAGER: ['notifications', 'dashboard', 'items', 'suppliers', 'requisitions', 'purchase-orders', 'grns', 'purchase-invoices', 'payments', 'reports', 'stock', 'purchase-returns'],
  PURCHASE_EXECUTIVE: ['notifications', 'dashboard', 'items', 'suppliers', 'requisitions', 'purchase-orders', 'grns', 'purchase-invoices', 'stock'],
  PRODUCTION_MANAGER: ['notifications', 'dashboard', 'items', 'boms', 'machines', 'work-orders', 'material-issues', 'production-entries', 'mrp', 'qc-inspections', 'stock', 'reports'],
  PRODUCTION_SUPERVISOR: ['notifications', 'dashboard', 'work-orders', 'material-issues', 'production-entries', 'mrp', 'qc-inspections', 'stock'],
  PLANT_MANAGER: ['notifications', 'dashboard', 'items', 'boms', 'machines', 'work-orders', 'material-issues', 'production-entries', 'mrp', 'qc-inspections', 'stock', 'reports'],
  OPERATOR: ['notifications', 'dashboard', 'work-orders', 'production-entries', 'stock'],
  STORE_MANAGER: ['notifications', 'dashboard', 'items', 'warehouses', 'stock', 'stock-ledger', 'stock-transfers', 'stock-adjustments', 'grns', 'deliveries'],
  STORE_OPERATOR: ['notifications', 'dashboard', 'stock', 'stock-ledger', 'stock-transfers'],
  QUALITY_MANAGER: ['notifications', 'dashboard', 'items', 'qc-inspections', 'grns', 'production-entries', 'reports'],
  QC_INSPECTOR: ['notifications', 'dashboard', 'qc-inspections', 'stock'],
  ACCOUNTS_MANAGER: ['notifications', 'dashboard', 'sales-invoices', 'purchase-invoices', 'payments', 'expenses', 'receivables', 'payables', 'gst-report', 'reports', 'sales-returns', 'purchase-returns', 'cash-bank'],
  ACCOUNTANT: ['notifications', 'dashboard', 'sales-invoices', 'purchase-invoices', 'payments', 'expenses', 'receivables', 'payables', 'gst-report', 'reports', 'sales-returns', 'purchase-returns', 'cash-bank'],
  DISPATCH_MANAGER: ['notifications', 'dashboard', 'sales-orders', 'deliveries', 'stock', 'items'],
  MAINTENANCE_MANAGER: ['notifications', 'dashboard', 'machines'],
  VIEWER: ['notifications', 'dashboard'],
}

/**
 * Sidebar entries that host several modules as tabs. Access to the entry = access to any tab;
 * each tab (and every API) is still checked by its own module key.
 */
export const MODULE_GROUP_CHILDREN: Record<string, string[]> = {
  parties: ['customers', 'suppliers'],
  'enquiries-quotes': ['enquiries', 'quotations'],
  'stock-hub': ['stock', 'stock-ledger'],
  'stock-movements': ['stock-transfers', 'stock-adjustments'],
  production: ['work-orders', 'material-issues', 'production-entries'],
  outstanding: ['receivables', 'payables'],
  'settings-hub': ['settings', 'company-setup'],
  activity: ['notifications', 'audit-log'],
}

/** Group entry that hosts a child module key (e.g. 'customers' → 'parties'). */
export const MODULE_PARENT: Record<string, string> = Object.fromEntries(
  Object.entries(MODULE_GROUP_CHILDREN).flatMap(([group, kids]) => kids.map((k) => [k, group])),
)

export function canAccessModule(role: string | null | undefined, moduleKey: string): boolean {
  if (!role) return false
  const kids = MODULE_GROUP_CHILDREN[moduleKey]
  if (kids) return kids.some((k) => canAccessModule(role, k))
  const allowed = ROLE_MODULE_KEYS[role]
  if (!allowed) return role === 'TENANT_ADMIN' // unknown roles default to minimal
  return allowed === '*' || allowed.includes(moduleKey)
}

/**
 * Sensitive financial reports (Phase 5, option A): the general `reports` permission is not enough — the role also
 * needs one of the money modules it already has (sales invoices, purchase invoices or Cash & Bank). Production,
 * plant and quality managers keep the operational reports (stock valuation, item detail, sales / purchase analysis).
 */
export const FINANCIAL_REPORTS = ['profit-loss', 'balance-sheet', 'trial-balance', 'cash-flow', 'daybook', 'transactions', 'profitability'] as const
export function canSeeFinancialReports(role: string | null | undefined): boolean {
  return canAccessModule(role, 'reports') && ['sales-invoices', 'purchase-invoices', 'cash-bank'].some((k) => canAccessModule(role, k))
}

/** GST state / UT codes (first two digits of a GSTIN). */
export const GST_STATES: { code: string; name: string }[] = [
  { code: '01', name: 'Jammu & Kashmir' }, { code: '02', name: 'Himachal Pradesh' }, { code: '03', name: 'Punjab' },
  { code: '04', name: 'Chandigarh' }, { code: '05', name: 'Uttarakhand' }, { code: '06', name: 'Haryana' },
  { code: '07', name: 'Delhi' }, { code: '08', name: 'Rajasthan' }, { code: '09', name: 'Uttar Pradesh' },
  { code: '10', name: 'Bihar' }, { code: '11', name: 'Sikkim' }, { code: '12', name: 'Arunachal Pradesh' },
  { code: '13', name: 'Nagaland' }, { code: '14', name: 'Manipur' }, { code: '15', name: 'Mizoram' },
  { code: '16', name: 'Tripura' }, { code: '17', name: 'Meghalaya' }, { code: '18', name: 'Assam' },
  { code: '19', name: 'West Bengal' }, { code: '20', name: 'Jharkhand' }, { code: '21', name: 'Odisha' },
  { code: '22', name: 'Chhattisgarh' }, { code: '23', name: 'Madhya Pradesh' }, { code: '24', name: 'Gujarat' },
  { code: '26', name: 'Dadra & Nagar Haveli and Daman & Diu' }, { code: '27', name: 'Maharashtra' },
  { code: '29', name: 'Karnataka' }, { code: '30', name: 'Goa' }, { code: '31', name: 'Lakshadweep' },
  { code: '32', name: 'Kerala' }, { code: '33', name: 'Tamil Nadu' }, { code: '34', name: 'Puducherry' },
  { code: '35', name: 'Andaman & Nicobar Islands' }, { code: '36', name: 'Telangana' }, { code: '37', name: 'Andhra Pradesh' },
  { code: '38', name: 'Ladakh' }, { code: '97', name: 'Other Territory' },
]
