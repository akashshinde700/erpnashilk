/**
 * The sidebar exactly as the app builds it (src/components/erp/registry.tsx): one entry per
 * screen, except for the tab groups that host several related screens behind one label.
 *
 * `tabs` lists the screens inside a group; a screen without `tabs` is a plain module.
 */
export interface ScreenDef {
  key: string
  label: string
  group: string
  tabs?: { key: string; label: string }[]
}

export const SCREENS: ScreenDef[] = [
  { key: 'dashboard', label: 'Dashboard', group: 'Dashboard' },

  { key: 'items', label: 'Items', group: 'Masters' },
  {
    key: 'parties', label: 'Parties', group: 'Masters',
    tabs: [
      { key: 'customers', label: 'Customers' },
      { key: 'suppliers', label: 'Suppliers' },
    ],
  },
  { key: 'warehouses', label: 'Warehouses', group: 'Masters' },
  { key: 'machines', label: 'Machines', group: 'Masters' },
  { key: 'boms', label: 'BOM', group: 'Masters' },
  { key: 'users', label: 'Users & Roles', group: 'Masters' },

  {
    key: 'enquiries-quotes', label: 'Enquiries & Quotes', group: 'Sales',
    tabs: [
      { key: 'enquiries', label: 'Enquiries' },
      { key: 'quotations', label: 'Quotations' },
    ],
  },
  { key: 'crm', label: 'CRM', group: 'Sales' },
  { key: 'sales-orders', label: 'Sales Orders', group: 'Sales' },
  { key: 'deliveries', label: 'Delivery Challans', group: 'Sales' },
  { key: 'sales-invoices', label: 'Sales Invoices', group: 'Sales' },
  { key: 'sales-returns', label: 'Sales Returns', group: 'Sales' },
  { key: 'pos', label: 'POS', group: 'Sales' },
  { key: 'payments', label: 'Payment In / Out', group: 'Sales' },

  { key: 'requisitions', label: 'Requisitions', group: 'Purchase' },
  { key: 'purchase-orders', label: 'Purchase Orders', group: 'Purchase' },
  { key: 'grns', label: 'GRN', group: 'Purchase' },
  { key: 'purchase-invoices', label: 'Purchase Invoices', group: 'Purchase' },
  { key: 'purchase-returns', label: 'Purchase Returns', group: 'Purchase' },

  {
    key: 'stock-hub', label: 'Stock', group: 'Inventory',
    tabs: [
      { key: 'stock', label: 'Stock Balance' },
      { key: 'stock-ledger', label: 'Stock Ledger' },
    ],
  },
  {
    key: 'stock-movements', label: 'Transfers & Adjustments', group: 'Inventory',
    tabs: [
      { key: 'stock-transfers', label: 'Transfers' },
      { key: 'stock-adjustments', label: 'Adjustments' },
    ],
  },

  {
    key: 'production', label: 'Production', group: 'Manufacturing',
    tabs: [
      { key: 'work-orders', label: 'Work Orders' },
      { key: 'material-issues', label: 'Material Issues' },
      { key: 'production-entries', label: 'Production Entries' },
    ],
  },
  { key: 'mrp', label: 'MRP', group: 'Manufacturing' },
  { key: 'qc-inspections', label: 'QC Inspections', group: 'Manufacturing' },

  {
    key: 'outstanding', label: 'Outstanding', group: 'Finance',
    tabs: [
      { key: 'receivables', label: 'Receivables' },
      { key: 'payables', label: 'Payables' },
    ],
  },
  { key: 'cash-bank', label: 'Cash & Bank', group: 'Finance' },
  { key: 'expenses', label: 'Expenses', group: 'Finance' },
  { key: 'gst-report', label: 'GST Reports', group: 'Finance' },
  { key: 'reports', label: 'Reports Center', group: 'Finance' },

  { key: 'import-center', label: 'Import Center', group: 'Utilities' },

  {
    key: 'settings-hub', label: 'Settings', group: 'Admin',
    tabs: [
      { key: 'settings', label: 'Settings' },
      { key: 'company-setup', label: 'Company Setup' },
    ],
  },
  {
    key: 'activity', label: 'Activity', group: 'Admin',
    tabs: [
      { key: 'notifications', label: 'Notifications' },
      { key: 'audit-log', label: 'Audit Log' },
    ],
  },
]

/** Sidebar section order (registry: MODULE_GROUPS). */
export const MODULE_GROUPS = ['Dashboard', 'Masters', 'Sales', 'Purchase', 'Inventory', 'Manufacturing', 'Finance', 'Utilities', 'Admin']

/** Every screen inside a sidebar entry (a plain module counts once). */
export const ALL_SCREENS = SCREENS.flatMap((s) => s.tabs ?? [{ key: s.key, label: s.label }])
