/**
 * ManuFlow ERP — Seed script
 * Run: bun prisma/seed.ts
 * Idempotent: skips companies that already exist.
 */
import { PrismaClient } from '@prisma/client'
import { hashPassword, DEMO_PASSWORD } from '../src/lib/password'

const db = new PrismaClient({ log: ['error'] })

const r2 = (n: number) => Math.round(n * 100) / 100

function fyOf(d = new Date()): string {
  const y = d.getFullYear()
  const m = d.getMonth() + 1
  const s = m >= 4 ? y : y - 1
  return `${String(s % 100).padStart(2, '0')}${String((s + 1) % 100).padStart(2, '0')}`
}

async function docNumber(companyId: string, docType: string, prefix: string, date = new Date()): Promise<string> {
  const fy = fyOf(date)
  const existing = await db.numberSeq.findUnique({
    where: { companyId_docType_financialYear: { companyId, docType, financialYear: fy } },
  })
  let n: number
  if (existing) {
    await db.numberSeq.update({ where: { id: existing.id }, data: { nextNumber: { increment: 1 } } })
    n = existing.nextNumber
  } else {
    await db.numberSeq.create({ data: { companyId, docType, prefix, financialYear: fy, nextNumber: 2 } })
    n = 1
  }
  return `${prefix}-${fy}-${String(n).padStart(6, '0')}`
}

interface PostInput {
  itemId: string; warehouseId: string; type: string; qtyIn?: number; qtyOut?: number
  rate?: number; refType?: string; refId?: string; refNumber?: string; notes?: string
}

async function postStock(companyId: string, p: PostInput) {
  const bal = await db.stockBalance.findUnique({
    where: { itemId_warehouseId: { itemId: p.itemId, warehouseId: p.warehouseId } },
  })
  const prevQty = bal?.qty || 0
  const prevRate = bal?.avgRate || 0
  const qtyIn = p.qtyIn || 0, qtyOut = p.qtyOut || 0
  const newQty = r2(prevQty + qtyIn - qtyOut)
  const newRate = qtyIn > 0 && p.rate ? r2((prevQty * prevRate + qtyIn * p.rate) / (prevQty + qtyIn)) : prevRate
  await db.stockLedger.create({
    data: {
      companyId, date: new Date(), itemId: p.itemId, warehouseId: p.warehouseId,
      type: p.type, qtyIn, qtyOut, rate: p.rate || 0, refType: p.refType, refNumber: p.refNumber, notes: p.notes,
    },
  })
  if (bal) await db.stockBalance.update({ where: { id: bal.id }, data: { qty: newQty, avgRate: newRate } })
  else await db.stockBalance.create({ data: { companyId, itemId: p.itemId, warehouseId: p.warehouseId, qty: newQty, avgRate: newRate } })
}

async function daysAgo(n: number): Promise<Date> {
  return new Date(Date.now() - n * 24 * 3600 * 1000)
}

async function main() {
  // ---------------- Company 2 (tenant isolation demo) ----------------
  const bharat = await db.company.findFirst({ where: { name: 'Bharat Motors Ltd' } })
  if (!bharat) {
    const c2 = await db.company.create({
      data: {
        name: 'Bharat Motors Ltd', gstin: '24AABCB1234C1ZP', state: 'Gujarat', stateCode: '24',
        city: 'Vadodara', addressLine: 'Plot 42, GIDC Makarpura', phone: '+91 98200 11223',
        users: { create: { name: 'Bharat Admin', email: 'admin@bharatmotors.in', role: 'TENANT_ADMIN', passwordHash: hashPassword(DEMO_PASSWORD) } },
        items: {
          create: [
            { code: 'BM-STATOR', name: 'Stator Winding Assembly', type: 'FINISHED', uom: 'NOS', gstRate: 18, sellingPrice: 15500, standardCost: 12400, reorderLevel: 10, purchasePrice: 12400 },
            { code: 'BM-VARNISH', name: 'Insulating Varnish', type: 'CONSUMABLE', uom: 'LTR', gstRate: 18, purchasePrice: 480, reorderLevel: 40 },
          ],
        },
        customers: { create: [{ code: 'C-001', name: 'Rajkot machine Tools', gstin: '24AAJCR9876F1Z5', state: 'Gujarat', stateCode: '24', city: 'Rajkot', paymentTermsDays: 45 }] },
      },
    })
    const wh = await db.warehouse.create({ data: { companyId: c2.id, code: 'WH-MAIN', name: 'Main Store', type: 'GENERAL', location: 'Vadodara Plant' } })
    const stator = await db.item.findFirst({ where: { companyId: c2.id, code: 'BM-STATOR' } })
    if (stator) await postStock(c2.id, { itemId: stator.id, warehouseId: wh.id, type: 'OPENING', qtyIn: 15, rate: 12400, refType: 'OPENING', notes: 'Opening stock' })
    console.log('✓ Seeded tenant: Bharat Motors Ltd')
  }

  // ---------------- Company 1 (main demo tenant) ----------------
  const acme = await db.company.findFirst({ where: { name: 'Acme Precision Manufacturing Pvt Ltd' } })
  if (acme) {
    console.log('✓ Acme already seeded — skipping')
    return
  }

  const co = await db.company.create({
    data: {
      name: 'Acme Precision Manufacturing Pvt Ltd',
      gstin: '27AAACA1234F1Z5', pan: 'AAACA1234F',
      addressLine: 'Survey 112, MIDC Bhosari', city: 'Pune', state: 'Maharashtra', stateCode: '27',
      phone: '+91 98220 44556', email: 'sales@acmeprecision.in', logoText: 'ACME',
    },
  })
  const coId = co.id

  // Users
  await db.user.createMany({
    data: [
      { companyId: coId, name: 'Rajesh Deshmukh', email: 'rajesh@acmeprecision.in', role: 'TENANT_ADMIN', phone: '+91 98220 11111', passwordHash: hashPassword(DEMO_PASSWORD) },
      { companyId: coId, name: 'Priya Kulkarni', email: 'priya@acmeprecision.in', role: 'SALES_MANAGER' },
      { companyId: coId, name: 'Amit Patil', email: 'amit@acmeprecision.in', role: 'PURCHASE_MANAGER' },
      { companyId: coId, name: 'Suresh Joshi', email: 'suresh@acmeprecision.in', role: 'PRODUCTION_MANAGER' },
      { companyId: coId, name: 'Vikram Shinde', email: 'vikram@acmeprecision.in', role: 'PRODUCTION_SUPERVISOR' },
      { companyId: coId, name: 'Anita Gokhale', email: 'anita@acmeprecision.in', role: 'QUALITY_MANAGER' },
      { companyId: coId, name: 'Deepak Rane', email: 'deepak@acmeprecision.in', role: 'STORE_MANAGER' },
      { companyId: coId, name: 'Sarita Mhatre', email: 'sarita@acmeprecision.in', role: 'ACCOUNTANT' },
      { companyId: coId, name: 'Rahul Pawar', email: 'rahul@acmeprecision.in', role: 'OPERATOR', passwordHash: hashPassword(DEMO_PASSWORD) },
    ],
  })

  // Warehouses
  const whRM = await db.warehouse.create({ data: { companyId: coId, code: 'WH-RM', name: 'Raw Material Store', type: 'RM', location: 'Bhosari Plant' } })
  const whFG = await db.warehouse.create({ data: { companyId: coId, code: 'WH-FG', name: 'Finished Goods Store', type: 'FG', location: 'Bhosari Plant' } })

  // Items
  const item = async (code: string, name: string, type: string, uom: string, gstRate: number, purchasePrice: number, sellingPrice: number, standardCost: number, reorderLevel: number, hsn: string) =>
    db.item.create({
      data: { companyId: coId, code, name, type, uom, gstRate, purchasePrice, sellingPrice, standardCost, reorderLevel, hsn, category: type === 'FINISHED' ? 'Motors & Pumps' : type === 'RAW' ? 'Raw Materials' : 'Consumables' },
    })

  const msSheet = await item('RM-MSHEET', 'MS Sheet 2mm', 'RAW', 'KG', 18, 78, 0, 78, 500, '7209')
  const copper = await item('RM-COPPER', 'Copper Wire 2.5mm', 'RAW', 'KG', 18, 820, 0, 820, 200, '7408')
  const bearing = await item('RM-BEARING', 'Ball Bearing 6204', 'RAW', 'NOS', 18, 95, 0, 95, 100, '8482')
  const screw = await item('RM-SCREW', 'Hex Screw M6', 'RAW', 'NOS', 18, 3, 0, 3, 500, '7318')
  const paint = await item('RM-PAINT', 'Epoxy Paint Black', 'RAW', 'LTR', 18, 340, 0, 340, 50, '3209')
  const rotor = await item('RM-ROTOR', 'Rotor Core Assembly', 'RAW', 'NOS', 18, 1250, 0, 1250, 40, '8503')
  const housing = await item('SF-HOUSING', 'Motor Housing Cast', 'SEMI', 'NOS', 18, 480, 0, 480, 50, '8503')
  const motor1 = await item('FG-MOTOR1', 'Motor Assembly 1HP', 'FINISHED', 'NOS', 18, 9800, 12500, 9800, 20, '8501')
  const motor5 = await item('FG-MOTOR5', 'Motor Assembly 5HP', 'FINISHED', 'NOS', 18, 31000, 38500, 31000, 10, '8501')
  const pump = await item('FG-PUMP', 'Monoblock Pump 2HP', 'FINISHED', 'NOS', 18, 7200, 8900, 7200, 15, '8413')
  const lube = await item('CN-LUBE', 'Machine Lubricant', 'CONSUMABLE', 'LTR', 18, 210, 0, 210, 30, '2710')
  const wrod = await item('CN-WROD', 'Welding Rods 3.15mm', 'CONSUMABLE', 'KG', 18, 160, 0, 160, 100, '8311')

  // Customers
  const cus1 = await db.customer.create({ data: { companyId: coId, code: 'CUS-001', name: 'Shakti Pumps Industries', gstin: '24AAKCS4567H1ZQ', contactPerson: 'Mahesh Patel', phone: '+91 98240 55555', email: 'purchase@shaktipumps.in', addressLine: 'Phase II, GIDC Vatva', city: 'Ahmedabad', state: 'Gujarat', stateCode: '24', paymentTermsDays: 45, creditLimit: 1000000 } })
  const cus2 = await db.customer.create({ data: { companyId: coId, code: 'CUS-002', name: 'Delhi Electric Traders', gstin: '07AAFCD8765K1ZK', contactPerson: 'Rakesh Khanna', phone: '+91 98110 22222', email: 'rk@delectric.in', addressLine: '12, Bhagirath Place', city: 'New Delhi', state: 'Delhi', stateCode: '07', paymentTermsDays: 30, creditLimit: 500000 } })
  const cus3 = await db.customer.create({ data: { companyId: coId, code: 'CUS-003', name: 'Nashik Agro Equipments', gstin: '27AAFCN2233L1ZM', contactPerson: 'Sunil Bhoir', phone: '+91 98230 33333', email: 'sunil@nashikagro.in', addressLine: 'Cidco, Ambad Lane', city: 'Nashik', state: 'Maharashtra', stateCode: '27', paymentTermsDays: 30, creditLimit: 750000 } })

  // Suppliers
  const sup1 = await db.supplier.create({ data: { companyId: coId, code: 'SUP-001', name: 'Tata Steel Processing Pune', gstin: '27AAACT9876M1ZR', contactPerson: 'Nitin Kadam', phone: '+91 98221 66666', email: 'sales@tatasteelpp.in', addressLine: 'Taloja MIDC', city: 'Navi Mumbai', state: 'Maharashtra', stateCode: '27', paymentTermsDays: 30 } })
  const sup2 = await db.supplier.create({ data: { companyId: coId, code: 'SUP-002', name: 'Copperfield Conductors Pvt Ltd', gstin: '24AAJCC5566N1ZT', contactPerson: 'Jignesh Shah', phone: '+91 98795 77777', email: 'jignesh@copperfield.in', addressLine: 'Naroda Industrial Estate', city: 'Ahmedabad', state: 'Gujarat', stateCode: '24', paymentTermsDays: 45 } })
  const sup3 = await db.supplier.create({ data: { companyId: coId, code: 'SUP-003', name: 'SK Bearings Co.', gstin: '07AAECS1122O1ZV', contactPerson: 'Sanjay Verma', phone: '+91 98990 88888', email: 'sanjay@skbearings.in', addressLine: 'Lajpat Nagar Market', city: 'New Delhi', state: 'Delhi', stateCode: '07', paymentTermsDays: 30 } })

  // Machines
  await db.machine.createMany({
    data: [
      { companyId: coId, code: 'MCN-CNC1', name: 'CNC Lathe — Katana', workCenter: 'WC-MACHINING', capacityPerDay: 120, hourlyRate: 450 },
      { companyId: coId, code: 'MCN-WLD1', name: 'Welding Station 1', workCenter: 'WC-WELDING', capacityPerDay: 80, hourlyRate: 220 },
      { companyId: coId, code: 'MCN-ASM1', name: 'Motor Assembly Bench', workCenter: 'WC-ASSEMBLY', capacityPerDay: 60, hourlyRate: 180 },
      { companyId: coId, code: 'MCN-TEST', name: 'Motor Test Rig', workCenter: 'WC-TESTING', capacityPerDay: 90, hourlyRate: 150 },
    ],
  })

  // BOMs
  const bom1 = await db.bom.create({
    data: {
      companyId: coId, code: 'BOM-MOTOR1HP', outputItemId: motor1.id, outputQty: 1, version: 'V1', status: 'ACTIVE',
      notes: '1HP Motor — standard build',
      items: {
        create: [
          { itemId: housing.id, qty: 1, scrapPct: 2 },
          { itemId: rotor.id, qty: 1, scrapPct: 1 },
          { itemId: bearing.id, qty: 2, scrapPct: 2 },
          { itemId: copper.id, qty: 5, scrapPct: 5 },
          { itemId: screw.id, qty: 8, scrapPct: 0 },
          { itemId: paint.id, qty: 0.4, scrapPct: 0 },
        ],
      },
    },
  })
  const bom5 = await db.bom.create({
    data: {
      companyId: coId, code: 'BOM-MOTOR5HP', outputItemId: motor5.id, outputQty: 1, version: 'V1', status: 'ACTIVE',
      notes: '5HP Motor — heavy duty',
      items: {
        create: [
          { itemId: housing.id, qty: 1, scrapPct: 2 },
          { itemId: rotor.id, qty: 1, scrapPct: 1 },
          { itemId: bearing.id, qty: 4, scrapPct: 2 },
          { itemId: copper.id, qty: 12, scrapPct: 5 },
          { itemId: screw.id, qty: 12, scrapPct: 0 },
          { itemId: paint.id, qty: 0.8, scrapPct: 0 },
        ],
      },
    },
  })
  await db.bom.create({
    data: {
      companyId: coId, code: 'BOM-PUMP2HP', outputItemId: pump.id, outputQty: 1, version: 'V1', status: 'ACTIVE',
      notes: 'Monoblock pump uses 1HP motor as sub-assembly',
      items: {
        create: [
          { itemId: motor1.id, qty: 1, scrapPct: 1 },
          { itemId: screw.id, qty: 6, scrapPct: 0 },
          { itemId: paint.id, qty: 0.3, scrapPct: 0 },
        ],
      },
    },
  })

  // Opening stock
  const opening: [typeof msSheet, number, number, typeof whRM | typeof whFG][] = [
    [msSheet, 800, 78, whRM], [copper, 350, 820, whRM], [bearing, 400, 95, whRM],
    [screw, 2000, 3, whRM], [paint, 80, 340, whRM], [rotor, 120, 1250, whRM],
    [housing, 90, 480, whRM], [lube, 60, 210, whRM], [wrod, 150, 160, whRM],
    [motor1, 25, 9800, whFG], [motor5, 8, 31000, whFG], [pump, 15, 7200, whFG],
  ]
  for (const [it, qty, rate, wh] of opening) {
    await postStock(coId, { itemId: it.id, warehouseId: wh.id, type: 'OPENING', qtyIn: qty, rate, refType: 'OPENING', notes: 'Opening balance' })
  }

  // ---- Sample transactional docs ----
  const d15 = await daysAgo(15)

  // Enquiry (OPEN)
  const enqNo = await docNumber(coId, 'ENQ', 'ENQ', d15)
  const enq = await db.enquiry.create({
    data: {
      companyId: coId, number: enqNo, customerId: cus1.id, date: d15, contactName: 'Mahesh Patel', source: 'PHONE',
      status: 'OPEN', notes: 'Needs delivery in 3 weeks',
      items: { create: [{ itemId: motor1.id, qty: 10 }, { itemId: pump.id, qty: 6 }] },
    },
  })

  // Quotation (SENT)
  const qtNo = await docNumber(coId, 'QT', 'QT', await daysAgo(12))
  await db.quotation.create({
    data: {
      companyId: coId, number: qtNo, enquiryId: enq.id, customerId: cus2.id, date: await daysAgo(12),
      validUntil: new Date(Date.now() + 15 * 86400000), status: 'SENT',
      subtotal: 4 * 38500, cgst: r2(4 * 38500 * 0.09), sgst: r2(4 * 38500 * 0.09), grandTotal: r2(4 * 38500 * 1.18),
      notes: '5HP motors for Delhi distributor',
      items: { create: [{ itemId: motor5.id, qty: 4, rate: 38500, gstRate: 18, lineTotal: 4 * 38500 }] },
    },
  })

  // Sales Order (CONFIRMED) — local customer so CGST/SGST
  const soNo = await docNumber(coId, 'SO', 'SO', await daysAgo(8))
  const so = await db.salesOrder.create({
    data: {
      companyId: coId, number: soNo, customerId: cus3.id, orderDate: await daysAgo(8),
      deliveryDate: new Date(Date.now() + 7 * 86400000), status: 'CONFIRMED',
      subtotal: 20 * 12500 + 10 * 8900, cgst: r2((20 * 12500 + 10 * 8900) * 0.09), sgst: r2((20 * 12500 + 10 * 8900) * 0.09),
      grandTotal: r2((20 * 12500 + 10 * 8900) * 1.18),
      notes: 'Annual contract order',
      items: {
        create: [
          { itemId: motor1.id, qty: 20, rate: 12500, gstRate: 18, lineTotal: 20 * 12500 },
          { itemId: pump.id, qty: 10, rate: 8900, gstRate: 18, lineTotal: 10 * 8900 },
        ],
      },
    },
  })

  // Work Order (RELEASED) from SO
  const woNo = await docNumber(coId, 'WO', 'WO', await daysAgo(7))
  await db.workOrder.create({
    data: {
      companyId: coId, number: woNo, itemId: motor1.id, bomId: bom1.id, salesOrderId: so.id, warehouseId: whFG.id,
      plannedQty: 20, status: 'RELEASED', startDate: await daysAgo(7), dueDate: new Date(Date.now() + 7 * 86400000),
      priority: 'HIGH', notes: 'Against ' + soNo,
    },
  })

  // Purchase Requisition (PENDING)
  const prNo = await docNumber(coId, 'PR', 'PR', await daysAgo(5))
  await db.purchaseRequisition.create({
    data: {
      companyId: coId, number: prNo, date: await daysAgo(5), requiredBy: new Date(Date.now() + 5 * 86400000),
      department: 'Stores', raisedBy: 'Deepak Rane', status: 'PENDING', notes: 'Reorder level triggered',
      items: { create: [{ itemId: msSheet.id, qty: 500 }, { itemId: copper.id, qty: 150 }] },
    },
  })

  // Purchase Order (APPROVED)
  const poNo = await docNumber(coId, 'PO', 'PO', await daysAgo(4))
  const poSub = 500 * 76 + 30 * 95
  const po = await db.purchaseOrder.create({
    data: {
      companyId: coId, number: poNo, supplierId: sup1.id, orderDate: await daysAgo(4),
      expectedDate: new Date(Date.now() + 4 * 86400000), status: 'APPROVED',
      approvedBy: 'Amit Patil', approvedAt: await daysAgo(4),
      subtotal: poSub, cgst: r2(poSub * 0.09), sgst: r2(poSub * 0.09), grandTotal: r2(poSub * 1.18),
      items: {
        create: [
          { itemId: msSheet.id, qty: 500, rate: 76, gstRate: 18, lineTotal: 500 * 76 },
          { itemId: bearing.id, qty: 30, rate: 95, gstRate: 18, lineTotal: 30 * 95 },
        ],
      },
    },
  })

  // Paid Sales Invoice (older order, IGST to Gujarat customer)
  const invSub = 8 * 8900
  const invNo = await docNumber(coId, 'INV', 'INV', await daysAgo(20))
  const inv = await db.salesInvoice.create({
    data: {
      companyId: coId, number: invNo, customerId: cus1.id, date: await daysAgo(20),
      dueDate: new Date(Date.now() + 25 * 86400000), placeOfSupply: 'Gujarat', isInterState: true,
      subtotal: invSub, igst: r2(invSub * 0.18), grandTotal: r2(invSub * 1.18),
      paidAmount: r2(invSub * 1.18), status: 'PAID', irn: `IRN${Date.now().toString().slice(-12)}`,
      notes: 'Full advance payment received',
      items: { create: [{ itemId: pump.id, hsn: '8413', qty: 8, rate: 8900, gstRate: 18, lineTotal: invSub }] },
    },
  })
  const rcptNo = await docNumber(coId, 'RCPT', 'RCPT', await daysAgo(18))
  await db.payment.create({
    data: {
      companyId: coId, number: rcptNo, type: 'RECEIPT', partyType: 'CUSTOMER', customerId: cus1.id,
      invoiceType: 'SALES', invoiceId: inv.id, amount: r2(invSub * 1.18), mode: 'NEFT', date: await daysAgo(18),
      reference: 'UTIB0000123-NEFT-8871', notes: 'Payment against ' + invNo,
    },
  })

  // Expenses
  const expNo1 = await docNumber(coId, 'EXP', 'EXP', await daysAgo(10))
  await db.expense.create({ data: { companyId: coId, number: expNo1, date: await daysAgo(10), category: 'FREIGHT', description: 'Outbound freight — Nashik order', amount: 6500, paymentMode: 'UPI', paidTo: 'Sai Roadlines', gstAmount: 0 } })
  const expNo2 = await docNumber(coId, 'EXP', 'EXP', await daysAgo(3))
  await db.expense.create({ data: { companyId: coId, number: expNo2, date: await daysAgo(3), category: 'UTILITIES', description: 'MSEB electricity bill — plant', amount: 42500, paymentMode: 'BANK', paidTo: 'MSEDCL', gstAmount: 7650 } })

  // Notifications
  await db.notification.createMany({
    data: [
      { companyId: coId, title: 'Welcome to ManuFlow ERP', message: 'Demo data loaded. Explore Dashboard → Sales → Manufacturing workflow.', level: 'INFO' },
      { companyId: coId, title: 'PO pending action', message: `${poNo} approved and awaiting GRN.`, level: 'INFO' },
      { companyId: coId, title: 'Work order released', message: `${woNo} for Motor Assembly 1HP × 20 is ready for material issue.`, level: 'WARNING' },
    ],
  })

  await db.auditLog.create({
    data: { companyId: coId, userName: 'system', action: 'CONFIG', entity: 'SEED', details: 'Initial demo data seeded' },
  })

  console.log(`✓ Seeded Acme Precision Manufacturing (${coId})`)
  console.log(`  Items: 12 | BOMs: 3 | Customers: 3 | Suppliers: 3 | SO: ${soNo} | WO: ${woNo} | PO: ${poNo} | INV: ${invNo}`)
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => db.$disconnect())
