'use client'

import { ComponentType } from 'react'
import {
  LayoutDashboard, Package, Users, Truck, Building2, Wrench, Layers3, UserCog,
  ClipboardList, FileText, ShoppingCart, Boxes, Warehouse, ArrowLeftRight, SlidersHorizontal,
  Factory, ClipboardCheck, Award, ReceiptIndianRupee, Wallet, Landmark, Percent,
  ScrollText, Settings, Handshake, FileSpreadsheet, PackageCheck,
} from 'lucide-react'

import DashboardModule from '@/components/erp/modules/dashboard'
import ItemsModule from '@/components/erp/modules/items'
import CustomersModule from '@/components/erp/modules/customers'
import SuppliersModule from '@/components/erp/modules/suppliers'
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
import ReceivablesModule from '@/components/erp/modules/receivables'
import PayablesModule from '@/components/erp/modules/payables'
import GstReportModule from '@/components/erp/modules/gst-report'
import AuditLogModule from '@/components/erp/modules/audit-log'
import SettingsModule from '@/components/erp/modules/settings'

export interface ErpModuleDef {
  key: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  group: string
  description?: string
  component: ComponentType<{ companyId: string }>
}

export const MODULE_GROUPS = ['Dashboard', 'Masters', 'Sales', 'Purchase', 'Inventory', 'Manufacturing', 'Quality', 'Finance', 'GST', 'Admin'] as const

export const MODULES: ErpModuleDef[] = [
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
  { key: 'payments', label: 'Payments', icon: Wallet, group: 'Sales', description: 'Receipts & supplier payments', component: PaymentsModule },
  // Purchase
  { key: 'requisitions', label: 'Requisitions', icon: ClipboardList, group: 'Purchase', component: RequisitionsModule },
  { key: 'purchase-orders', label: 'Purchase Orders', icon: ShoppingCart, group: 'Purchase', component: PurchaseOrdersModule },
  { key: 'grns', label: 'GRN', icon: PackageCheck, group: 'Purchase', description: 'Goods receipt notes', component: GrnsModule },
  { key: 'purchase-invoices', label: 'Purchase Invoices', icon: FileSpreadsheet, group: 'Purchase', component: PurchaseInvoicesModule },
  // Inventory
  { key: 'stock', label: 'Stock', icon: Boxes, group: 'Inventory', component: StockModule },
  { key: 'stock-ledger', label: 'Stock Ledger', icon: ScrollText, group: 'Inventory', component: StockLedgerModule },
  { key: 'stock-transfers', label: 'Transfers', icon: ArrowLeftRight, group: 'Inventory', component: StockTransfersModule },
  { key: 'stock-adjustments', label: 'Adjustments', icon: SlidersHorizontal, group: 'Inventory', component: StockAdjustmentsModule },
  // Manufacturing
  { key: 'work-orders', label: 'Work Orders', icon: Factory, group: 'Manufacturing', component: WorkOrdersModule },
  { key: 'material-issues', label: 'Material Issues', icon: Boxes, group: 'Manufacturing', component: MaterialIssuesModule },
  { key: 'production-entries', label: 'Production', icon: Factory, group: 'Manufacturing', description: 'Production entries & FG receipt', component: ProductionEntriesModule },
  { key: 'mrp', label: 'MRP', icon: Layers3, group: 'Manufacturing', description: 'Material requirements planning', component: MrpModule },
  // Quality
  { key: 'qc-inspections', label: 'QC Inspections', icon: ClipboardCheck, group: 'Quality', component: QcInspectionsModule },
  // Finance
  { key: 'expenses', label: 'Expenses', icon: Wallet, group: 'Finance', component: ExpensesModule },
  { key: 'receivables', label: 'Receivables', icon: Handshake, group: 'Finance', component: ReceivablesModule },
  { key: 'payables', label: 'Payables', icon: Landmark, group: 'Finance', component: PayablesModule },
  // GST
  { key: 'gst-report', label: 'GST Reports', icon: Percent, group: 'GST', component: GstReportModule },
  // Admin
  { key: 'audit-log', label: 'Audit Log', icon: ScrollText, group: 'Admin', component: AuditLogModule },
  { key: 'settings', label: 'Settings', icon: Settings, group: 'Admin', description: 'Company profile, numbering, notifications', component: SettingsModule },
]

export function findModule(key: string): ErpModuleDef | undefined {
  return MODULES.find((m) => m.key === key)
}
