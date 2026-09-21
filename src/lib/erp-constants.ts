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
export const EXPENSE_CATEGORIES = ['UTILITIES', 'FREIGHT', 'RENT', 'SALARY', 'MAINTENANCE', 'TOOLING', 'OTHER'] as const
export const STOCK_TYPES = ['OPENING', 'GRN_IN', 'ISSUE_OUT', 'PRODUCTION_IN', 'DISPATCH_OUT', 'TRANSFER_IN', 'TRANSFER_OUT', 'ADJUST_IN', 'ADJUST_OUT', 'RETURN_IN', 'QC_REJECT', 'SALES_RETURN'] as const

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
  error?: { code: string; message: string }
}

// ============ RBAC: role → visible module keys (client-side gating) ============
// '*' = full access. Server still enforces tenant isolation; this gates navigation only.
export const ROLE_MODULE_KEYS: Record<string, string[] | '*'> = {
  TENANT_ADMIN: '*',
  MANAGEMENT: '*',
  SUPER_ADMIN: '*',
  SALES_MANAGER: ['notifications', 'dashboard', 'items', 'customers', 'enquiries', 'quotations', 'sales-orders', 'deliveries', 'sales-invoices', 'payments', 'reports', 'stock'],
  SALES_EXECUTIVE: ['notifications', 'dashboard', 'items', 'customers', 'enquiries', 'quotations', 'sales-orders', 'deliveries', 'sales-invoices', 'stock'],
  PURCHASE_MANAGER: ['notifications', 'dashboard', 'items', 'suppliers', 'requisitions', 'purchase-orders', 'grns', 'purchase-invoices', 'payments', 'reports', 'stock'],
  PURCHASE_EXECUTIVE: ['notifications', 'dashboard', 'items', 'suppliers', 'requisitions', 'purchase-orders', 'grns', 'purchase-invoices', 'stock'],
  PRODUCTION_MANAGER: ['notifications', 'dashboard', 'items', 'boms', 'machines', 'work-orders', 'material-issues', 'production-entries', 'mrp', 'qc-inspections', 'stock', 'reports'],
  PRODUCTION_SUPERVISOR: ['notifications', 'dashboard', 'work-orders', 'material-issues', 'production-entries', 'mrp', 'qc-inspections', 'stock'],
  PLANT_MANAGER: ['notifications', 'dashboard', 'items', 'boms', 'machines', 'work-orders', 'material-issues', 'production-entries', 'mrp', 'qc-inspections', 'stock', 'reports'],
  OPERATOR: ['notifications', 'dashboard', 'work-orders', 'production-entries', 'stock'],
  STORE_MANAGER: ['notifications', 'dashboard', 'items', 'warehouses', 'stock', 'stock-ledger', 'stock-transfers', 'stock-adjustments', 'grns', 'deliveries'],
  STORE_OPERATOR: ['notifications', 'dashboard', 'stock', 'stock-ledger', 'stock-transfers'],
  QUALITY_MANAGER: ['notifications', 'dashboard', 'items', 'qc-inspections', 'grns', 'production-entries', 'reports'],
  QC_INSPECTOR: ['notifications', 'dashboard', 'qc-inspections', 'stock'],
  ACCOUNTS_MANAGER: ['notifications', 'dashboard', 'sales-invoices', 'purchase-invoices', 'payments', 'expenses', 'receivables', 'payables', 'gst-report', 'reports'],
  ACCOUNTANT: ['notifications', 'dashboard', 'sales-invoices', 'purchase-invoices', 'payments', 'expenses', 'receivables', 'payables', 'gst-report', 'reports'],
  DISPATCH_MANAGER: ['notifications', 'dashboard', 'sales-orders', 'deliveries', 'stock', 'items'],
  MAINTENANCE_MANAGER: ['notifications', 'dashboard', 'machines'],
  VIEWER: ['notifications', 'dashboard'],
}

export function canAccessModule(role: string | null | undefined, moduleKey: string): boolean {
  if (!role) return false
  const allowed = ROLE_MODULE_KEYS[role]
  if (!allowed) return role === 'TENANT_ADMIN' // unknown roles default to minimal
  return allowed === '*' || allowed.includes(moduleKey)
}
