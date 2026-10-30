'use client'

import { ComponentType } from 'react'
import {
  LayoutDashboard, Package, Users, Truck, Building2, Wrench, Layers3, UserCog,
  ClipboardList, FileText, ShoppingCart, Boxes, Warehouse, ArrowLeftRight, SlidersHorizontal,
  Factory, ClipboardCheck, Award, ReceiptIndianRupee, Wallet, Landmark, Percent, Activity,
  ScrollText, Settings, Handshake, FileSpreadsheet, PackageCheck, BarChart3, Bell, Undo2, Redo2, FileUp,
} from 'lucide-react'

import DashboardModule from '@/components/erp/modules/dashboard'
import ItemsModule from '@/components/erp/modules/items'
import CustomersModule from '@/components/erp/modules/customers'
import SuppliersModule from '@/components/erp/modules/suppliers'
import { makeTabGroup } from '@/components/erp/tab-group'
import { MODULE_GROUP_CHILDREN } from '@/lib/erp-constants'
import WarehousesModule from '@/components/erp/modules/warehouses'
import MachinesModule from '@/components/erp/modules/machines'
import BomsModule from '@/components/erp/modules/boms'
import UsersModule from '@/components/erp/modules/users'
import EnquiriesModule from '@/components/erp/modules/enquiries'
import QuotationsModule from '@/components/erp/modules/quotations'
import SalesOrdersModule from '@/components/erp/modules/sales-orders'
import DeliveriesModule from '@/components/erp/modules/deliveries'
import SalesInvoicesModule from '@/components/erp/modules/sales-invoices'
import PaymentsModule from '@/components/erp/modules/payments'
import SalesReturnsModule from '@/components/erp/modules/sales-returns'
import PurchaseReturnsModule from '@/components/erp/modules/purchase-returns'
import RequisitionsModule from '@/components/erp/modules/requisitions'
import PurchaseOrdersModule from '@/components/erp/modules/purchase-orders'
import GrnsModule from '@/components/erp/modules/grns'
import PurchaseInvoicesModule from '@/components/erp/modules/purchase-invoices'
import WorkOrdersModule from '@/components/erp/modules/work-orders'
import MaterialIssuesModule from '@/components/erp/modules/material-issues'
import ProductionEntriesModule from '@/components/erp/modules/production-entries'
import MrpModule from '@/components/erp/modules/mrp'
import QcInspectionsModule from '@/components/erp/modules/qc-inspections'
import StockModule from '@/components/erp/modules/stock'
import StockLedgerModule from '@/components/erp/modules/stock-ledger'
import StockTransfersModule from '@/components/erp/modules/stock-transfers'
import StockAdjustmentsModule from '@/components/erp/modules/stock-adjustments'
import ExpensesModule from '@/components/erp/modules/expenses'
import CashBankModule from '@/components/erp/modules/cash-bank'
import ReceivablesModule from '@/components/erp/modules/receivables'
import PayablesModule from '@/components/erp/modules/payables'
import GstReportModule from '@/components/erp/modules/gst-report'
import AuditLogModule from '@/components/erp/modules/audit-log'
import NotificationsModule from '@/components/erp/modules/notifications'
import SettingsModule from '@/components/erp/modules/settings'
import ReportsModule from '@/components/erp/modules/reports'
import CompanySetupModule from '@/components/erp/modules/company-setup'
import ImportCenterModule from '@/components/erp/modules/import-center'

export interface ErpModuleDef {
  key: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  group: string
  description?: string
  component: ComponentType<{ companyId: string }>
  /** Routable (search, deep links) but not listed in the sidebar/palette — shown inside another module. */
  hidden?: boolean
}

export const MODULE_GROUPS = ['Dashboard', 'Masters', 'Sales', 'Purchase', 'Inventory', 'Manufacturing', 'Finance', 'Utilities', 'Admin'] as const

// Every screen. Modules hosted inside a tab group are `hidden` (not listed in the sidebar) but stay
// routable by key — search results, shortcuts and quick actions open the group on that tab.
const SCREENS: ErpModuleDef[] = [
  // Dashboard
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, group: 'Dashboard', description: 'Business KPIs at a glance', component: DashboardModule },
  // Masters
  { key: 'items', label: 'Items', icon: Package, group: 'Masters', description: 'Raw materials, finished goods & consumables', component: ItemsModule },
  { key: 'customers', label: 'Customers', icon: Users, group: 'Masters', component: CustomersModule },
  { key: 'suppliers', label: 'Suppliers', icon: Truck, group: 'Masters', component: SuppliersModule },
  { key: 'warehouses', label: 'Warehouses', icon: Warehouse, group: 'Masters', component: WarehousesModule },
  { key: 'machines', label: 'Machines', icon: Wrench, group: 'Masters', component: MachinesModule },
  { key: 'boms', label: 'BOM', icon: Layers3, group: 'Masters', description: 'Bill of Materials', component: BomsModule },
  { key: 'users', label: 'Users & Roles', icon: UserCog, group: 'Masters', component: UsersModule },
  // Sales
  { key: 'enquiries', label: 'Enquiries', icon: ClipboardList, group: 'Sales', component: EnquiriesModule },
  { key: 'quotations', label: 'Quotations', icon: FileText, group: 'Sales', component: QuotationsModule },
  { key: 'sales-orders', label: 'Sales Orders', icon: ShoppingCart, group: 'Sales', component: SalesOrdersModule },
  { key: 'deliveries', label: 'Delivery Challans', icon: Truck, group: 'Sales', component: DeliveriesModule },
  { key: 'sales-invoices', label: 'Sales Invoices', icon: ReceiptIndianRupee, group: 'Sales', description: 'GST tax invoices', component: SalesInvoicesModule },
  { key: 'sales-returns', label: 'Sales Returns', icon: Undo2, group: 'Sales', description: 'Credit notes — goods back from customers', component: SalesReturnsModule },
  { key: 'payments', label: 'Payment In / Out', icon: Wallet, group: 'Sales', description: 'Payment In (from customers) & Payment Out (to suppliers)', component: PaymentsModule },
  // Purchase
  { key: 'requisitions', label: 'Requisitions', icon: ClipboardList, group: 'Purchase', component: RequisitionsModule },
  { key: 'purchase-orders', label: 'Purchase Orders', icon: ShoppingCart, group: 'Purchase', component: PurchaseOrdersModule },
  { key: 'grns', label: 'GRN', icon: PackageCheck, group: 'Purchase', description: 'Goods receipt notes', component: GrnsModule },
  { key: 'purchase-invoices', label: 'Purchase Invoices', icon: FileSpreadsheet, group: 'Purchase', component: PurchaseInvoicesModule },
  { key: 'purchase-returns', label: 'Purchase Returns', icon: Redo2, group: 'Purchase', description: 'Debit notes — goods sent back to suppliers', component: PurchaseReturnsModule },
  // Inventory
  { key: 'stock', label: 'Stock Balance', icon: Boxes, group: 'Inventory', component: StockModule },
  { key: 'stock-ledger', label: 'Stock Ledger', icon: ScrollText, group: 'Inventory', component: StockLedgerModule },
  { key: 'stock-transfers', label: 'Transfers', icon: ArrowLeftRight, group: 'Inventory', component: StockTransfersModule },
  { key: 'stock-adjustments', label: 'Adjustments', icon: SlidersHorizontal, group: 'Inventory', component: StockAdjustmentsModule },
  // Manufacturing
  { key: 'work-orders', label: 'Work Orders', icon: Factory, group: 'Manufacturing', component: WorkOrdersModule },
  { key: 'material-issues', label: 'Material Issues', icon: Boxes, group: 'Manufacturing', component: MaterialIssuesModule },
  { key: 'production-entries', label: 'Production Entries', icon: Factory, group: 'Manufacturing', description: 'Production entries & FG receipt', component: ProductionEntriesModule },
  { key: 'mrp', label: 'MRP', icon: Layers3, group: 'Manufacturing', description: 'Material requirements planning', component: MrpModule },
  { key: 'qc-inspections', label: 'QC Inspections', icon: ClipboardCheck, group: 'Manufacturing', component: QcInspectionsModule },
  // Finance
  { key: 'receivables', label: 'Receivables', icon: Handshake, group: 'Finance', component: ReceivablesModule },
  { key: 'payables', label: 'Payables', icon: Landmark, group: 'Finance', component: PayablesModule },
  { key: 'cash-bank', label: 'Cash & Bank', icon: Landmark, group: 'Finance', description: 'Cash in hand, bank accounts, contra, loans', component: CashBankModule },
  { key: 'expenses', label: 'Expenses', icon: Wallet, group: 'Finance', component: ExpensesModule },
  { key: 'gst-report', label: 'GST Reports', icon: Percent, group: 'Finance', component: GstReportModule },
  { key: 'reports', label: 'Reports Center', icon: BarChart3, group: 'Finance', description: 'Sales, purchase, stock & profitability analytics', component: ReportsModule },
  // Utilities
  { key: 'import-center', label: 'Import Center', icon: FileUp, group: 'Utilities', description: 'Import customers & items from Tally, Vyapar or Excel / CSV', component: ImportCenterModule },
  // Admin
  { key: 'settings', label: 'Settings', icon: Settings, group: 'Admin', description: 'Company profile, numbering, notifications', component: SettingsModule },
  { key: 'company-setup', label: 'Company Setup', icon: Building2, group: 'Admin', description: 'Create & manage tenant companies', component: CompanySetupModule },
  { key: 'notifications', label: 'Notifications', icon: Bell, group: 'Admin', description: 'View, filter & manage all notifications', component: NotificationsModule },
  { key: 'audit-log', label: 'Audit Log', icon: ScrollText, group: 'Admin', component: AuditLogModule },
]

// Sidebar entries that combine related screens as tabs (tabs listed in MODULE_GROUP_CHILDREN).
// `after` places the entry right after another one in its group; empty = first in the group.
const GROUP_ENTRIES: { key: string; label: string; icon: ErpModuleDef['icon']; group: string; description: string; after: string }[] = [
  { key: 'parties', label: 'Parties', icon: Users, group: 'Masters', description: 'Customers & suppliers', after: 'items' },
  { key: 'enquiries-quotes', label: 'Enquiries & Quotes', icon: ClipboardList, group: 'Sales', description: 'Enquiries and quotations', after: '' },
  { key: 'stock-hub', label: 'Stock', icon: Boxes, group: 'Inventory', description: 'Stock balance & ledger', after: '' },
  { key: 'stock-movements', label: 'Transfers & Adjustments', icon: ArrowLeftRight, group: 'Inventory', description: 'Move stock between stores or correct it', after: 'stock-hub' },
  { key: 'production', label: 'Production', icon: Factory, group: 'Manufacturing', description: 'Work orders, material issues & production entries', after: '' },
  { key: 'outstanding', label: 'Outstanding', icon: Handshake, group: 'Finance', description: 'Receivables & payables', after: '' },
  { key: 'settings-hub', label: 'Settings', icon: Settings, group: 'Admin', description: 'Company profile, numbering & companies', after: '' },
  { key: 'activity', label: 'Activity', icon: Activity, group: 'Admin', description: 'Notifications & audit log', after: 'settings-hub' },
]

function buildModules(): ErpModuleDef[] {
  const byKey = new Map(SCREENS.map((m) => [m.key, m]))
  const childKeys = new Set(Object.values(MODULE_GROUP_CHILDREN).flat())

  const toEntry = (e: (typeof GROUP_ENTRIES)[number]): ErpModuleDef => {
    const tabs = MODULE_GROUP_CHILDREN[e.key].map((k) => {
      const m = byKey.get(k)!
      return { key: k, label: m.label, component: m.component }
    })
    return { key: e.key, label: e.label, icon: e.icon, group: e.group, description: e.description, component: makeTabGroup(tabs) }
  }

  const out: ErpModuleDef[] = []
  for (const g of MODULE_GROUPS) {
    const entries = GROUP_ENTRIES.filter((e) => e.group === g)
    const rows: ErpModuleDef[] = [
      ...entries.filter((e) => !e.after).map(toEntry),
      ...SCREENS.filter((m) => m.group === g && !childKeys.has(m.key)),
    ]
    for (const e of entries.filter((x) => x.after)) {
      const i = rows.findIndex((r) => r.key === e.after)
      rows.splice(i >= 0 ? i + 1 : rows.length, 0, toEntry(e))
    }
    out.push(...rows)
  }
  // Tab children: hidden from the sidebar, still routable by key
  for (const k of childKeys) {
    const m = byKey.get(k)
    if (m) out.push({ ...m, hidden: true })
  }
  return out
}

export const MODULES: ErpModuleDef[] = buildModules()

export function findModule(key: string): ErpModuleDef | undefined {
  return MODULES.find((m) => m.key === key)
}
