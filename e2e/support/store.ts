/**
 * Seed data for the in-browser fake API used by the Playwright suite.
 *
 * The shapes mirror what the Next.js route handlers return (see the interfaces at the top of
 * each `src/components/erp/modules/*.tsx`), so every screen renders exactly as it would with a
 * real database. Numbers are chosen to be recognisable in assertions.
 */

export const COMPANY_ID = 'cmp_nashilk'
export const SECOND_COMPANY_ID = 'cmp_components'
export const ADMIN_EMAIL = 'owner@nashilk.test'
export const ADMIN_PASSWORD = 'Secret@123'

export interface SeedUser {
  id: string
  name: string
  email: string
  phone?: string
  role: string
  active: boolean
  companyId: string
  password: string
}

export const company = {
  id: COMPANY_ID,
  name: 'Nashilk Precision Works',
  gstin: '27ABCDE1234F1Z5',
  pan: 'ABCDE1234F',
  addressLine: 'Plot 14, MIDC Bhosari',
  city: 'Pune',
  state: 'Maharashtra',
  stateCode: '27',
  pincode: '411026',
  phone: '020-27123456',
  email: 'accounts@nashilk.test',
  logoText: 'NPW',
  bankAccountName: 'Nashilk Precision Works',
  bankAccountNumber: '50100234567890',
  bankIfsc: 'HDFC0001234',
  bankName: 'HDFC Bank',
  bankBranch: 'Bhosari MIDC',
  bankUpiId: 'nashilk@hdfcbank',
  invoiceTerms: 'Goods once sold will not be taken back. Subject to Pune jurisdiction.',
  quotationTerms: 'Prices valid for 15 days.',
  roundOffTotals: true,
  lockEnabled: false,
  isHome: true,
  status: 'ACTIVE',
}

const secondCompany = {
  id: SECOND_COMPANY_ID,
  name: 'Nashilk Components LLP',
  gstin: '27AAECN4567M1Z2',
  pan: 'AAECN4567M',
  addressLine: 'Gat 220, Chakan',
  city: 'Pune',
  state: 'Maharashtra',
  stateCode: '27',
  pincode: '410501',
  phone: '020-27998888',
  email: 'hello@components.test',
  logoText: 'NCL',
  roundOffTotals: true,
  isHome: false,
  status: 'ACTIVE',
}

export const companies = [company, secondCompany]

export const users: SeedUser[] = [
  { id: 'usr_admin', name: 'Akash Shinde', email: ADMIN_EMAIL, phone: '9822012345', role: 'TENANT_ADMIN', active: true, companyId: COMPANY_ID, password: ADMIN_PASSWORD },
  { id: 'usr_planner', name: 'Rohit Kulkarni', email: 'planner@nashilk.test', phone: '9822012346', role: 'PLANNER', active: true, companyId: COMPANY_ID, password: ADMIN_PASSWORD },
  { id: 'usr_store', name: 'Sunita Patil', email: 'store@nashilk.test', phone: '9822012347', role: 'STORE_KEEPER', active: false, companyId: COMPANY_ID, password: ADMIN_PASSWORD },
]

export const customers = [
  { id: 'cus_1', code: 'CUST-0001', name: 'Precision Tools Pvt Ltd', type: 'CUSTOMER', contactPerson: 'Mahesh Rao', phone: '9890011223', email: 'purchase@precisiontools.test', gstin: '27AABCP1234C1ZU', gstType: 'REGISTERED', pan: 'AABCP1234C', state: 'Maharashtra', stateCode: '27', city: 'Pune', pincode: '411038', addressLine: 'Shop 8, Kothrud', country: 'India', creditLimit: 250000, active: true, createdAt: '2026-04-02T04:00:00.000Z' },
  { id: 'cus_2', code: 'CUST-0002', name: 'Deccan Auto Systems', type: 'CUSTOMER', contactPerson: 'Farah Khan', phone: '9890011224', email: 'accounts@deccanauto.test', gstin: '29AACCD9876K1Z3', gstType: 'REGISTERED', pan: 'AACCD9876K', state: 'Karnataka', stateCode: '29', city: 'Bengaluru', pincode: '560058', addressLine: 'Peenya Industrial Area', country: 'India', creditLimit: 500000, active: true, createdAt: '2026-04-11T04:00:00.000Z' },
  { id: 'cus_3', code: 'CUST-0003', name: 'Sahyadri Pumps', type: 'CUSTOMER', contactPerson: 'Nitin Joshi', phone: '9890011225', email: 'stores@sahyadripumps.test', gstin: '27AADCS5555P1Z9', gstType: 'REGISTERED', pan: 'AADCS5555P', state: 'Maharashtra', stateCode: '27', city: 'Nashik', pincode: '422007', addressLine: 'Satpur MIDC', country: 'India', creditLimit: 100000, active: true, createdAt: '2026-05-06T04:00:00.000Z' },
  { id: 'cus_4', code: 'CUST-0004', name: 'Vidarbha Traders', type: 'BOTH', contactPerson: 'Sagar Deshmukh', phone: '9890011226', email: 'sagar@vidarbhatraders.test', gstin: '27AAFCV7777L1Z6', gstType: 'COMPOSITION', pan: 'AAFCV7777L', state: 'Maharashtra', stateCode: '27', city: 'Nagpur', pincode: '440016', addressLine: 'Hingna Road', country: 'India', creditLimit: 75000, active: true, createdAt: '2026-06-19T04:00:00.000Z' },
]

export const suppliers = [
  { id: 'sup_1', code: 'SUPP-0001', name: 'Bharat Steel Depot', type: 'SUPPLIER', contactPerson: 'Iqbal Shaikh', phone: '9870011223', email: 'sales@bharatsteel.test', gstin: '27AABCB1111D1ZR', gstType: 'REGISTERED', pan: 'AABCB1111D', state: 'Maharashtra', stateCode: '27', city: 'Pune', pincode: '411019', addressLine: 'Bhosari Steel Market', country: 'India', active: true, createdAt: '2026-03-14T04:00:00.000Z' },
  { id: 'sup_2', code: 'SUPP-0002', name: 'Gujarat Bearings Co', type: 'SUPPLIER', contactPerson: 'Parth Mehta', phone: '9870011224', email: 'orders@gujaratbearings.test', gstin: '24AACCG2222E1Z4', gstType: 'REGISTERED', pan: 'AACCG2222E', state: 'Gujarat', stateCode: '24', city: 'Rajkot', pincode: '360004', addressLine: 'Gondal Road', country: 'India', active: true, createdAt: '2026-03-28T04:00:00.000Z' },
  { id: 'sup_3', code: 'SUPP-0003', name: 'Shree Lubricants', type: 'SUPPLIER', contactPerson: 'Deepak Yadav', phone: '9870011225', email: 'deepak@shreelub.test', gstin: '27AAHCS3333F1ZM', gstType: 'UNREGISTERED', pan: 'AAHCS3333F', state: 'Maharashtra', stateCode: '27', city: 'Pimpri', pincode: '411018', addressLine: 'Telco Road', country: 'India', active: true, createdAt: '2026-04-22T04:00:00.000Z' },
]

export const items = [
  { id: 'itm_1', code: 'RM-EN8', name: 'EN8 Round Bar 40mm', type: 'RAW', uom: 'KG', hsn: '7214', gstRate: 18, purchasePrice: 78, sellingPrice: 96, reorderLevel: 250, onHand: 480, category: 'Raw Material', active: true },
  { id: 'itm_2', code: 'RM-BRG', name: 'Ball Bearing 6204', type: 'RAW', uom: 'NOS', hsn: '8482', gstRate: 18, purchasePrice: 132, sellingPrice: 165, reorderLevel: 100, onHand: 64, category: 'Bought Out', active: true },
  { id: 'itm_3', code: 'RM-OIL', name: 'Cutting Oil 5L', type: 'CONSUMABLE', uom: 'LTR', hsn: '2710', gstRate: 18, purchasePrice: 340, sellingPrice: 420, reorderLevel: 40, onHand: 22, category: 'Consumable', active: true },
  { id: 'itm_4', code: 'FG-SFT', name: 'Shaft Assembly SF-220', type: 'FINISHED', uom: 'NOS', hsn: '8483', gstRate: 18, purchasePrice: 640, sellingPrice: 1250, reorderLevel: 20, onHand: 85, category: 'Finished Goods', active: true },
  { id: 'itm_5', code: 'FG-FLG', name: 'Flange Coupling FC-90', type: 'FINISHED', uom: 'NOS', hsn: '8483', gstRate: 12, purchasePrice: 410, sellingPrice: 780, reorderLevel: 15, onHand: 12, category: 'Finished Goods', active: true },
  { id: 'itm_6', code: 'SV-MACH', name: 'Machine maintenance service', type: 'SERVICE', uom: 'JOB', hsn: '9987', gstRate: 18, purchasePrice: 0, sellingPrice: 4500, reorderLevel: 0, onHand: 0, category: 'Service', active: true },
]

export const warehouses = [
  { id: 'wh_1', code: 'MAIN', name: 'Main store', type: 'GENERAL', city: 'Pune', active: true },
  { id: 'wh_2', code: 'FG', name: 'Finished goods store', type: 'FINISHED', city: 'Pune', active: true },
  { id: 'wh_3', code: 'WIP', name: 'Shop floor WIP', type: 'WIP', city: 'Pune', active: true },
]

export const machines = [
  { id: 'mc_1', code: 'CNC-01', name: 'CNC Turning Center', type: 'CNC', capacityPerHour: 22, status: 'ACTIVE', location: 'Bay 1' },
  { id: 'mc_2', code: 'VMC-02', name: 'VMC Milling', type: 'VMC', capacityPerHour: 15, status: 'ACTIVE', location: 'Bay 2' },
  { id: 'mc_3', code: 'GRD-03', name: 'Cylindrical Grinder', type: 'GRINDER', capacityPerHour: 9, status: 'MAINTENANCE', location: 'Bay 3' },
]

export const boms = [
  {
    id: 'bom_1', code: 'BOM-SF220', name: 'Shaft Assembly SF-220', itemId: 'itm_4', outputQty: 1, status: 'ACTIVE',
    item: { id: 'itm_4', code: 'FG-SFT', name: 'Shaft Assembly SF-220', uom: 'NOS' },
    items: [
      { id: 'boml_1', itemId: 'itm_1', qty: 2.4, item: { id: 'itm_1', code: 'RM-EN8', name: 'EN8 Round Bar 40mm', uom: 'KG' } },
      { id: 'boml_2', itemId: 'itm_2', qty: 2, item: { id: 'itm_2', code: 'RM-BRG', name: 'Ball Bearing 6204', uom: 'NOS' } },
    ],
  },
  {
    id: 'bom_2', code: 'BOM-FC90', name: 'Flange Coupling FC-90', itemId: 'itm_5', outputQty: 1, status: 'ACTIVE',
    item: { id: 'itm_5', code: 'FG-FLG', name: 'Flange Coupling FC-90', uom: 'NOS' },
    items: [{ id: 'boml_3', itemId: 'itm_1', qty: 1.8, item: { id: 'itm_1', code: 'RM-EN8', name: 'EN8 Round Bar 40mm', uom: 'KG' } }],
  },
]

const salesInvoiceBase = {
  customer: { id: 'cus_1', name: 'Precision Tools Pvt Ltd', gstin: '27AABCP1234C1ZU' },
}

export const salesInvoices = [
  {
    ...salesInvoiceBase, id: 'si_1', number: 'INV/26-27/0001', date: '2026-09-03', dueDate: '2026-10-03', placeOfSupply: '27',
    customerId: 'cus_1', status: 'POSTED', subtotal: 25000, discountTotal: 0, cgst: 2250, sgst: 2250, igst: 0,
    grandTotal: 29500, paidAmount: 29500, roundOff: 0, isInterState: false,
    // Line detail so the Tally / e-Invoice exports have something to describe
    items: [{
      id: 'sii_1', itemId: 'itm_4', hsn: '84836090', qty: 5, rate: 5000, discountPct: 0, gstRate: 18,
      lineTotal: 25000, item: { id: 'itm_4', code: 'FG-SFT', name: 'Shaft Assembly SF-220', uom: 'NOS' },
    }],
  },
  { ...salesInvoiceBase, id: 'si_2', number: 'INV/26-27/0002', date: '2026-09-18', dueDate: '2026-10-18', placeOfSupply: '29', customerId: 'cus_2', customer: { id: 'cus_2', name: 'Deccan Auto Systems', gstin: '29AACCD9876K1Z3' }, status: 'PARTIALLY_PAID', subtotal: 42000, discountTotal: 2000, cgst: 0, sgst: 0, igst: 7200, grandTotal: 47200, paidAmount: 20000, roundOff: 0, isInterState: true, items: [] },
  { ...salesInvoiceBase, id: 'si_3', number: 'INV/26-27/0003', date: '2026-10-06', dueDate: '2026-11-06', placeOfSupply: '27', customerId: 'cus_3', customer: { id: 'cus_3', name: 'Sahyadri Pumps', gstin: '27AADCS5555P1Z9' }, status: 'DRAFT', subtotal: 15600, discountTotal: 0, cgst: 1404, sgst: 1404, igst: 0, grandTotal: 18408, paidAmount: 0, roundOff: 0, isInterState: false, items: [] },
  { ...salesInvoiceBase, id: 'si_5', number: 'INV/26-27/0005', date: '2026-10-24', dueDate: '2026-11-24', placeOfSupply: '27', customerId: 'cus_1', customer: { id: 'cus_1', name: 'Precision Tools Pvt Ltd', gstin: '27AABCP1234C1ZU' }, status: 'UNPAID', subtotal: 30000, discountTotal: 0, cgst: 2700, sgst: 2700, igst: 0, grandTotal: 35400, paidAmount: 0, roundOff: 0, isInterState: false, items: [] },
  { ...salesInvoiceBase, id: 'si_4', number: 'INV/26-27/0004', date: '2026-10-21', dueDate: '2026-11-21', placeOfSupply: '27', customerId: 'cus_1', status: 'CANCELLED', subtotal: 9000, discountTotal: 0, cgst: 810, sgst: 810, igst: 0, grandTotal: 10620, paidAmount: 0, roundOff: 0, isInterState: false, items: [] },
]

export const purchaseInvoices = [
  { id: 'pi_1', number: 'BILL/26-27/0001', supplierInvNo: 'BSD/2291', date: '2026-09-05', dueDate: '2026-10-05', supplierId: 'sup_1', supplier: { id: 'sup_1', name: 'Bharat Steel Depot', gstin: '27AABCB1111D1ZR' }, status: 'POSTED', subtotal: 31200, discountTotal: 0, cgst: 2808, sgst: 2808, igst: 0, cess: 0, grandTotal: 36816, paidAmount: 36816, itcEligible: true, isInterState: false, items: [] },
  { id: 'pi_2', number: 'BILL/26-27/0002', supplierInvNo: 'GBC-771', date: '2026-09-21', dueDate: '2026-10-21', supplierId: 'sup_2', supplier: { id: 'sup_2', name: 'Gujarat Bearings Co', gstin: '24AACCG2222E1Z4' }, status: 'UNPAID', subtotal: 18400, discountTotal: 400, cgst: 0, sgst: 0, igst: 3240, cess: 0, grandTotal: 21240, paidAmount: 0, itcEligible: true, isInterState: true, items: [] },
  { id: 'pi_3', number: 'BILL/26-27/0003', supplierInvNo: 'SB-119', date: '2026-10-12', dueDate: '2026-11-12', supplierId: 'sup_3', supplier: { id: 'sup_3', name: 'Shree Lubricants', gstin: '27AAHCS3333F1ZM' }, status: 'DRAFT', subtotal: 6800, discountTotal: 0, cgst: 612, sgst: 612, igst: 0, cess: 0, grandTotal: 8024, paidAmount: 0, itcEligible: false, isInterState: false, items: [] },
]

export const quotations = [
  { id: 'qt_1', number: 'QT/26-27/0001', date: '2026-08-28', validUntil: '2026-09-12', customerId: 'cus_1', customer: { name: 'Precision Tools Pvt Ltd' }, status: 'SENT', subtotal: 50000, grandTotal: 59000, items: [] },
  { id: 'qt_2', number: 'QT/26-27/0002', date: '2026-09-30', validUntil: '2026-10-15', customerId: 'cus_2', customer: { name: 'Deccan Auto Systems' }, status: 'DRAFT', subtotal: 22000, grandTotal: 25960, items: [] },
]

export const salesOrders = [
  { id: 'so_1', number: 'SO/26-27/0001', orderDate: '2026-09-01', customerId: 'cus_1', customer: { name: 'Precision Tools Pvt Ltd' }, status: 'CONFIRMED', subtotal: 50000, grandTotal: 59000, items: [] },
  { id: 'so_2', number: 'SO/26-27/0002', orderDate: '2026-09-14', customerId: 'cus_2', customer: { name: 'Deccan Auto Systems' }, status: 'RELEASED', subtotal: 42000, grandTotal: 47200, items: [] },
  { id: 'so_3', number: 'SO/26-27/0003', orderDate: '2026-10-02', customerId: 'cus_3', customer: { name: 'Sahyadri Pumps' }, status: 'DRAFT', subtotal: 15600, grandTotal: 18408, items: [] },
]

export const deliveries = [
  { id: 'dc_1', number: 'DC/26-27/0001', date: '2026-09-17', customerId: 'cus_2', customer: { name: 'Deccan Auto Systems' }, salesOrderId: 'so_2', salesOrder: { number: 'SO/26-27/0002', customer: { name: 'Deccan Auto Systems' } }, vehicleNo: 'MH 12 PQ 4471', status: 'DELIVERED', items: [] },
  { id: 'dc_2', number: 'DC/26-27/0002', date: '2026-10-05', customerId: 'cus_3', customer: { name: 'Sahyadri Pumps' }, salesOrder: { number: 'SO/26-27/0003', customer: { name: 'Sahyadri Pumps' } }, vehicleNo: 'MH 12 RS 9902', status: 'PENDING', items: [] },
]

export const salesReturns = [
  { id: 'sr_1', number: 'CN/26-27/0001', date: '2026-09-25', customerId: 'cus_1', customer: { name: 'Precision Tools Pvt Ltd' }, salesInvoiceId: 'si_1', status: 'POSTED', subtotal: 2500, cgst: 225, sgst: 225, igst: 0, grandTotal: 2950, items: [] },
]

export const enquiries = [
  { id: 'enq_1', number: 'ENQ/26-27/0001', date: '2026-08-20', customerId: 'cus_3', customer: { name: 'Sahyadri Pumps' }, status: 'OPEN', subject: 'Shaft assembly SF-220 - 200 nos', items: [] },
  { id: 'enq_2', number: 'ENQ/26-27/0002', date: '2026-09-11', customerId: 'cus_2', customer: { name: 'Deccan Auto Systems' }, status: 'QUOTED', subject: 'Flange coupling FC-90', items: [] },
]

export const payments = [
  { id: 'pay_1', number: 'RCPT/26-27/0001', date: '2026-09-04', type: 'IN', partyType: 'CUSTOMER', customerId: 'cus_1', customer: { name: 'Precision Tools Pvt Ltd' }, amount: 29500, mode: 'BANK', reference: 'NEFT-8891', accountId: 'acc_bank', accountName: 'HDFC Current', status: 'POSTED' },
  { id: 'pay_2', number: 'PMT/26-27/0001', date: '2026-09-06', type: 'OUT', partyType: 'SUPPLIER', supplierId: 'sup_1', supplier: { name: 'Bharat Steel Depot' }, amount: 36816, mode: 'BANK', reference: 'RTGS-2210', accountId: 'acc_bank', accountName: 'HDFC Current', status: 'POSTED' },
  { id: 'pay_3', number: 'RCPT/26-27/0002', date: '2026-09-19', type: 'IN', partyType: 'CUSTOMER', customerId: 'cus_2', customer: { name: 'Deccan Auto Systems' }, amount: 20000, mode: 'CHEQUE', reference: 'CHQ-4412', chequeNo: '4412', chequeStatus: 'CLEARED', accountId: 'acc_bank', accountName: 'HDFC Current', status: 'POSTED' },
]

export const purchaseRequisitions = [
  { id: 'pr_1', number: 'PR/26-27/0001', date: '2026-09-02', department: 'Production', raisedBy: 'Rohit Kulkarni', status: 'PENDING', items: [] },
  { id: 'pr_2', number: 'PR/26-27/0002', date: '2026-09-29', department: 'Maintenance', raisedBy: 'Sunita Patil', status: 'APPROVED', items: [] },
]

export const purchaseOrders = [
  { id: 'po_1', number: 'PO/26-27/0001', orderDate: '2026-09-03', supplierId: 'sup_1', supplier: { name: 'Bharat Steel Depot' }, status: 'RELEASED', subtotal: 31200, grandTotal: 36816, items: [] },
  { id: 'po_2', number: 'PO/26-27/0002', orderDate: '2026-09-20', supplierId: 'sup_2', supplier: { name: 'Gujarat Bearings Co' }, status: 'PENDING_APPROVAL', subtotal: 18400, grandTotal: 21240, items: [] },
]

export const grns = [
  { id: 'grn_1', number: 'GRN/26-27/0001', date: '2026-09-05', supplierId: 'sup_1', supplier: { name: 'Bharat Steel Depot' }, purchaseOrderId: 'po_1', status: 'RECEIVED', items: [] },
  { id: 'grn_2', number: 'GRN/26-27/0002', date: '2026-09-21', supplierId: 'sup_2', supplier: { name: 'Gujarat Bearings Co' }, status: 'RECEIVED', items: [] },
]

export const purchaseReturns = [
  { id: 'pret_1', number: 'DN/26-27/0001', date: '2026-09-26', supplierId: 'sup_1', supplier: { name: 'Bharat Steel Depot' }, purchaseInvoiceId: 'pi_1', status: 'POSTED', subtotal: 1200, cgst: 108, sgst: 108, igst: 0, grandTotal: 1416, items: [] },
]

export const stockLedger = [
  { id: 'sl_1', date: '2026-09-05', type: 'PURCHASE', refType: 'PURCHASE_INVOICE', refNumber: 'BILL/26-27/0001', itemId: 'itm_1', item: { code: 'RM-EN8', name: 'EN8 Round Bar 40mm', uom: 'KG' }, warehouse: 'Main store', qtyIn: 400, qtyOut: 0, rate: 78, balance: 400 },
  { id: 'sl_2', date: '2026-09-17', type: 'SALE', refType: 'SALES_INVOICE', refNumber: 'INV/26-27/0002', itemId: 'itm_1', item: { code: 'RM-EN8', name: 'EN8 Round Bar 40mm', uom: 'KG' }, warehouse: 'Main store', qtyIn: 0, qtyOut: 120, rate: 78, balance: 280 },
  { id: 'sl_4', date: '2026-10-08', type: 'TRANSFER_OUT', refType: 'STOCK_TRANSFER', refNumber: 'ST/26-27/0001', itemId: 'itm_5', item: { code: 'FG-FLG', name: 'Flange Coupling FC-90', uom: 'NOS' }, warehouse: 'Main store', qtyIn: 0, qtyOut: 10, rate: 410, balance: 2 },
  { id: 'sl_5', date: '2026-10-08', type: 'TRANSFER_IN', refType: 'STOCK_TRANSFER', refNumber: 'ST/26-27/0001', itemId: 'itm_5', item: { code: 'FG-FLG', name: 'Flange Coupling FC-90', uom: 'NOS' }, warehouse: 'Finished goods store', qtyIn: 10, qtyOut: 0, rate: 410, balance: 10 },
  { id: 'sl_3', date: '2026-10-01', type: 'PRODUCTION', refType: 'PRODUCTION_ENTRY', refNumber: 'PRD/26-27/0001', itemId: 'itm_4', item: { code: 'FG-SFT', name: 'Shaft Assembly SF-220', uom: 'NOS' }, warehouse: 'Finished goods store', qtyIn: 40, qtyOut: 0, rate: 640, balance: 40 },
]

export const stockTransfers = [
  {
    id: 'st_1', number: 'ST/26-27/0001', date: '2026-09-22', type: 'TRANSFER_OUT', qtyOut: 10,
    refNumber: 'ST/26-27/0001', status: 'POSTED', notes: 'Move finished couplings to dispatch store',
    itemId: 'itm_5', item: { id: 'itm_5', code: 'FG-FLG', name: 'Flange Coupling FC-90', uom: 'NOS' },
    fromWarehouseId: 'wh_1', toWarehouseId: 'wh_2',
    fromWarehouse: { id: 'wh_1', code: 'MAIN', name: 'Main store' },
    toWarehouse: { id: 'wh_2', code: 'FG', name: 'Finished goods store' },
  },
]

export const stockAdjustments = [
  {
    id: 'sa_1', number: 'ADJ/26-27/0001', date: '2026-09-30', type: 'ADJUSTMENT', qty: -2,
    reasonType: 'DAMAGE', reason: 'Cycle count — bearing outer race chipped', status: 'POSTED',
    refNumber: 'ADJ/26-27/0001',
    itemId: 'itm_3', item: { id: 'itm_3', code: 'RM-BRG', name: 'Ball Bearing 6204', uom: 'NOS' },
    warehouseId: 'wh_1', warehouse: { id: 'wh_1', code: 'MAIN', name: 'Main store' },
  },
]

export const workOrders = [
  { id: 'wo_1', number: 'WO/26-27/0001', date: '2026-09-08', itemId: 'itm_4', item: { code: 'FG-SFT', name: 'Shaft Assembly SF-220', uom: 'NOS' }, bomId: 'bom_1', machineId: 'mc_1', plannedQty: 100, producedQty: 60, status: 'IN_PROGRESS', startDate: '2026-09-09', dueDate: '2026-10-09' },
  { id: 'wo_2', number: 'WO/26-27/0002', date: '2026-09-26', itemId: 'itm_5', item: { code: 'FG-FLG', name: 'Flange Coupling FC-90', uom: 'NOS' }, bomId: 'bom_2', machineId: 'mc_2', plannedQty: 50, producedQty: 0, status: 'RELEASED', startDate: '2026-10-02', dueDate: '2026-10-20' },
]

export const materialIssues = [
  { id: 'mi_1', number: 'MI/26-27/0001', date: '2026-09-10', workOrderId: 'wo_1', workOrder: { number: 'WO/26-27/0001' }, status: 'POSTED', items: [{ itemId: 'itm_1', qty: 240 }] },
]

export const productionEntries = [
  { id: 'pe_1', number: 'PRD/26-27/0001', date: '2026-10-01', workOrderId: 'wo_1', workOrder: { number: 'WO/26-27/0001' }, itemId: 'itm_4', producedQty: 40, rejectedQty: 2, status: 'POSTED', items: [] },
]

export const qcInspections = [
  { id: 'qc_1', number: 'QC/26-27/0001', date: '2026-10-02', type: 'FINAL', status: 'PASSED', refType: 'WORK_ORDER', refNumber: 'WO/26-27/0001', itemId: 'itm_4', qtyChecked: 40, qtyAccepted: 38, qtyRejected: 2, parameters: 'OD 40.00 +0.02/-0.00', inspector: 'Sunita Patil', remarks: 'Minor burr on 2 pieces' },
  { id: 'qc_2', number: 'QC/26-27/0002', date: '2026-09-05', type: 'INCOMING', status: 'PARTIAL', refType: 'GRN', refNumber: 'GRN/26-27/0001', itemId: 'itm_1', qtyChecked: 400, qtyAccepted: 396, qtyRejected: 4, parameters: 'Diameter 40 ±0.05', inspector: 'Sunita Patil', remarks: '4 bars under size' },
]

export const accounts = [
  { id: 'acc_cash', type: 'CASH', name: 'Cash in Hand', openingBalance: 15000, openingDate: '2026-04-01', printOnInvoice: false, isDefault: true, active: true, balance: 42350 },
  { id: 'acc_bank', type: 'BANK', name: 'HDFC Current', bankName: 'HDFC Bank', accountNo: '50100234567890', ifsc: 'HDFC0001234', branch: 'Bhosari MIDC', upiId: 'nashilk@hdfcbank', openingBalance: 250000, openingDate: '2026-04-01', printOnInvoice: true, isDefault: false, active: true, balance: 318400 },
  { id: 'acc_od', type: 'BANK', name: 'ICICI OD', bankName: 'ICICI Bank', accountNo: '004901001234', ifsc: 'ICIC0000049', branch: 'Chakan', openingBalance: 0, openingDate: '2026-04-01', printOnInvoice: false, isDefault: false, active: true, balance: 0 },
]

export const accountTxns = [
  { id: 'txn_1', number: 'TRF/26-27/0001', date: '2026-09-12', type: 'CONTRA', fromAccountId: 'acc_cash', toAccountId: 'acc_bank', fromAccountName: 'Cash in Hand', toAccountName: 'HDFC Current', amount: 10000, notes: 'Cash deposited' },
  { id: 'txn_2', number: 'ADJ/26-27/0002', date: '2026-09-28', type: 'ADJUSTMENT', fromAccountId: 'acc_cash', amount: -1200, category: 'CASH_SHORT', notes: 'Till short' },
]

export const expenses = [
  { id: 'exp_1', number: 'EXP/26-27/0001', date: '2026-09-07', category: 'POWER', description: 'MSEB electricity bill', amount: 18400, paymentMode: 'BANK', paidTo: 'MSEDCL', gstAmount: 0, status: 'POSTED', accountId: 'acc_bank', accountName: 'HDFC Current', expenseType: 'INDIRECT' },
  { id: 'exp_3', number: 'EXP/26-27/0003', date: '2026-10-05', category: 'REPAIRS', description: 'CNC coolant pump repair', amount: 6400, paymentMode: 'CASH', paidTo: 'Kirloskar Service', gstAmount: 1152, status: 'POSTED', accountId: 'acc_cash', accountName: 'Cash in Hand', expenseType: 'DIRECT' },
  { id: 'exp_2', number: 'EXP/26-27/0002', date: '2026-09-24', category: 'FREIGHT', description: 'Outward freight to Bengaluru', amount: 4200, paymentMode: 'CASH', paidTo: 'VRL Logistics', gstAmount: 756, status: 'POSTED', itcEligible: true, vendorGstin: '29AABCV1234D1Z8', billNo: 'VRL-8891', accountId: 'acc_cash', accountName: 'Cash in Hand', expenseType: 'DIRECT' },
]

export const loans = [
  { id: 'loan_1', name: 'HDFC Term Loan', lender: 'HDFC Bank', loanAccountNo: 'TL-889123', principal: 500000, interestRate: 10.5, processingFee: 5000, startDate: '2026-05-01', termMonths: 24, emiAmount: 23200, receivedAccountId: 'acc_bank', receivedAccountName: 'HDFC Current', status: 'ACTIVE', principalPaid: 86000, interestPaid: 27000, outstanding: 414000, emiCount: 5 },
]

export const leads = [
  { id: 'lead_1', code: 'LD-0001', name: 'Rahul Deshmukh', companyName: 'Deccan Auto Systems', phone: '9822011001', email: 'rahul@deccanauto.test', city: 'Pune', source: 'REFERRAL', stage: 'QUALIFIED', value: 240000, probability: 45, owner: 'Sales', expectedCloseDate: '2026-11-20', notes: 'Wants 500 shafts per month', createdAt: '2026-10-20T06:00:00.000Z', updatedAt: '2026-10-27T06:00:00.000Z' },
  { id: 'lead_2', code: 'LD-0002', name: 'Sneha Kulkarni', companyName: 'Kothrud Engineering', phone: '9822011002', email: 'sneha@kothrudeng.test', city: 'Pune', source: 'WEBSITE', stage: 'PROPOSAL', value: 185000, probability: 60, owner: 'Sales', expectedCloseDate: '2026-11-05', notes: 'Quotation QT/26-27/0002 sent', createdAt: '2026-10-18T06:00:00.000Z', updatedAt: '2026-10-26T06:00:00.000Z' },
  { id: 'lead_3', code: 'LD-0003', name: 'Imran Shaikh', companyName: 'Hadapsar Fabricators', phone: '9822011003', email: 'imran@hadapsar.test', city: 'Pune', source: 'EXHIBITION', stage: 'NEW', value: 90000, probability: 10, owner: 'Sales', expectedCloseDate: '2026-12-01', notes: 'Met at the Pune expo', createdAt: '2026-10-25T06:00:00.000Z', updatedAt: '2026-10-25T06:00:00.000Z' },
  { id: 'lead_4', code: 'LD-0004', name: 'Vikram Patil', companyName: 'Chakan Precision', phone: '9822011004', email: 'vikram@chakan.test', city: 'Chakan', source: 'CALL', stage: 'WON', value: 320000, probability: 100, owner: 'Sales', customerId: 'cus_3', convertedAt: '2026-10-15T06:00:00.000Z', notes: 'Repeat order for flange couplings', createdAt: '2026-09-28T06:00:00.000Z', updatedAt: '2026-10-15T06:00:00.000Z' },
  { id: 'lead_5', code: 'LD-0005', name: 'Anita Rane', companyName: 'Bhosari Tools', phone: '9822011005', city: 'Pune', source: 'WHATSAPP', stage: 'CONTACTED', value: 60000, probability: 25, owner: 'Sales', notes: 'Asked for the price list', createdAt: '2026-10-26T06:00:00.000Z', updatedAt: '2026-10-28T06:00:00.000Z' },
]

export const leadActivities = [
  { id: 'act_1', leadId: 'lead_1', companyId: 'cmp_nashilk', kind: 'CALL', summary: 'Send revised quotation for 500 nos', dueDate: '2026-10-31', doneAt: null, notes: 'Price break above 400', createdAt: '2026-10-27T06:00:00.000Z' },
  { id: 'act_2', leadId: 'lead_2', companyId: 'cmp_nashilk', kind: 'MEETING', summary: 'Plant visit — discuss tolerances', dueDate: '2026-10-29', doneAt: null, notes: null, createdAt: '2026-10-26T06:00:00.000Z' },
  { id: 'act_3', leadId: 'lead_5', companyId: 'cmp_nashilk', kind: 'WHATSAPP', summary: 'Share the EN8 bar price list', dueDate: '2026-10-28', doneAt: null, notes: null, createdAt: '2026-10-26T06:00:00.000Z' },
  { id: 'act_4', leadId: 'lead_1', companyId: 'cmp_nashilk', kind: 'NOTE', summary: 'Spoke to Rahul — budget approved', dueDate: null, doneAt: '2026-10-26T06:00:00.000Z', notes: null, createdAt: '2026-10-26T06:00:00.000Z' },
]

export const notifications = [
  { id: 'ntf_1', title: 'Low stock: Flange Coupling FC-90', message: 'On hand 12 NOS, reorder level 15 NOS.', level: 'WARNING', read: false, createdAt: '2026-10-28T05:30:00.000Z' },
  { id: 'ntf_2', title: 'PO/26-27/0002 awaiting approval', message: 'Gujarat Bearings Co · ₹21,240', level: 'INFO', read: false, createdAt: '2026-10-27T09:10:00.000Z' },
  { id: 'ntf_3', title: 'GSTR-1 for September filed', message: 'ACK 2926101234567', level: 'SUCCESS', read: true, createdAt: '2026-10-12T11:00:00.000Z' },
]

export const auditLogs = [
  { id: 'aud_1', createdAt: '2026-10-28T06:20:00.000Z', action: 'CREATE', entity: 'SALES_INVOICE', entityId: 'si_3', userName: 'Akash Shinde', details: 'Created DRAFT INV/26-27/0003', ip: '103.21.58.4' },
  { id: 'aud_2', createdAt: '2026-10-27T10:02:00.000Z', action: 'UPDATE', entity: 'PURCHASE_ORDER', entityId: 'po_2', userName: 'Rohit Kulkarni', details: 'Submitted PO/26-27/0002 for approval', ip: '103.21.58.4' },
  { id: 'aud_3', createdAt: '2026-10-26T07:45:00.000Z', action: 'DELETE', entity: 'ITEM', entityId: 'itm_old', userName: 'Akash Shinde', details: 'Deleted obsolete item MS-BRKT', ip: '103.21.58.4' },
  { id: 'aud_4', createdAt: '2026-10-25T04:12:00.000Z', action: 'LOGIN', entity: 'USER', entityId: 'usr_admin', userName: 'Akash Shinde', details: 'Signed in', ip: '103.21.58.4' },
]

export const numberSeqs = [
  { id: 'seq_1', docType: 'SALES_INVOICE', prefix: 'INV/26-27/', financialYear: '2026-2027', nextNumber: 5 },
  { id: 'seq_2', docType: 'QUOTATION', prefix: 'QT/26-27/', financialYear: '2026-2027', nextNumber: 3 },
  { id: 'seq_3', docType: 'PURCHASE_ORDER', prefix: 'PO/26-27/', financialYear: '2026-2027', nextNumber: 3 },
]

export const batches = [
  { id: 'bat_1', batchNo: 'B-EN8-0926', itemId: 'itm_1', warehouseId: 'wh_1', qty: 400, mfgDate: '2026-09-01', expiryDate: null, rate: 78 },
  { id: 'bat_2', batchNo: 'B-BRG-0826', itemId: 'itm_2', warehouseId: 'wh_1', qty: 64, mfgDate: '2026-08-11', expiryDate: null, rate: 132 },
]

export const serials = [
  { id: 'ser_1', serialNo: 'SF220-0001', itemId: 'itm_4', warehouseId: 'wh_2', status: 'IN_STOCK' },
  { id: 'ser_2', serialNo: 'SF220-0002', itemId: 'itm_4', warehouseId: 'wh_2', status: 'IN_STOCK' },
]

export const importHistory = [
  { id: 'imp_1', kind: 'CUSTOMERS', fileName: 'customers-sep.csv', status: 'COMMITTED', rows: 42, created: '2026-09-30T06:00:00.000Z', user: 'Akash Shinde' },
]

export interface Store {
  session: { user: Record<string, unknown>; company: Record<string, unknown> } | null
  collections: Record<string, Record<string, any>[]>
  seq: number
  nextId(prefix: string): string
}

export function createStore(): Store {
  let seq = 1000
  return {
    session: null,
    seq,
    nextId(prefix: string) {
      seq += 1
      this.seq = seq
      return `${prefix}_${seq}`
    },
    collections: {
      companies: [...companies],
      users: users.map(({ password: _pw, ...u }) => ({ ...u, passwordHash: 'scrypt$test' })),
      customers: [...customers],
      suppliers: [...suppliers],
      parties: [...customers, ...suppliers],
      items: [...items],
      warehouses: [...warehouses],
      machines: [...machines],
      boms: [...boms],
      enquiries: [...enquiries],
      quotations: [...quotations],
      'sales-orders': [...salesOrders],
      deliveries: [...deliveries],
      'sales-invoices': [...salesInvoices],
      'sales-returns': [...salesReturns],
      payments: [...payments],
      'purchase-requisitions': [...purchaseRequisitions],
      'purchase-orders': [...purchaseOrders],
      grns: [...grns],
      'purchase-invoices': [...purchaseInvoices],
      'purchase-returns': [...purchaseReturns],
      'stock-ledger': [...stockLedger],
      'stock-transfers': [...stockTransfers],
      'stock-adjustments': [...stockAdjustments],
      stock: items.map((i) => ({
        id: `stk_${i.id}`, itemId: i.id, code: i.code, name: i.name, uom: i.uom,
        qty: i.onHand, onHand: i.onHand, reorderLevel: i.reorderLevel,
        value: i.onHand * i.purchasePrice, movingAvg: i.purchasePrice,
        item: { id: i.id, code: i.code, name: i.name, uom: i.uom, type: i.type },
        warehouse: { id: 'wh_1', code: 'MAIN', name: 'Main store' },
      })),
      'work-orders': [...workOrders],
      'material-issues': [...materialIssues],
      'production-entries': [...productionEntries],
      'qc-inspections': [...qcInspections],
      accounts: [...accounts],
      'account-txns': [...accountTxns],
      expenses: [...expenses],
      loans: [...loans],
      notifications: [...notifications],
      leads: leads.map((l) => ({
        ...l,
        // the next open follow-up, like the API's include
        activities: leadActivities
          .filter((a) => a.leadId === l.id && !a.doneAt)
          .sort((a, b) => String(a.dueDate || '').localeCompare(String(b.dueDate || '')))
          .slice(0, 1),
      })),
      'lead-activities': leadActivities.map((a) => ({
        ...a,
        lead: (() => {
          const l = leads.find((x) => x.id === a.leadId)
          return l ? { id: l.id, code: l.code, name: l.name, companyName: l.companyName, stage: l.stage } : null
        })(),
      })),
      'audit-logs': [...auditLogs],
      batches: [...batches],
      serials: [...serials],
      'import-history': [...importHistory],
    },
  }
}
