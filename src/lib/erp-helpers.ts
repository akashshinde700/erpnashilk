import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

// ============ Consistent API responses ============

export function ok<T>(data: T, message = '') {
  return NextResponse.json({ success: true, data, message })
}

export function fail(message: string, status = 400, code = 'ERR') {
  return NextResponse.json({ success: false, error: { code, message } }, { status })
}

// ============ Company (tenant) resolution ============

export async function resolveCompanyId(req: Request, bodyCompanyId?: string): Promise<string | null> {
  const { searchParams } = new URL(req.url)
  const cid = bodyCompanyId || searchParams.get('companyId') || req.headers.get('x-company-id')
  if (!cid) return null
  const company = await db.company.findUnique({ where: { id: cid } })
  return company ? company.id : null
}

export function companyRequired(req: Request, bodyCompanyId?: string): Promise<string> {
  return resolveCompanyId(req, bodyCompanyId).then((c) => {
    if (!c) throw new ApiError('companyId is required (valid tenant id)', 400)
    return c
  })
}

export class ApiError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

export function handleError(e: unknown) {
  if (e instanceof ApiError) return fail(e.message, e.status)
  const msg = e instanceof Error ? e.message : 'Internal server error'
  if (msg.includes('Unique constraint')) return fail('Duplicate record: code/number already exists', 409)
  if (msg.includes('Record to update not found') || msg.includes('No record was found')) return fail('Record not found', 404)
  console.error('[API]', msg)
  return fail(msg, 500)
}

// ============ Financial year + document numbering ============
// Indian FY: 1 Apr – 31 Mar. Format: PREFIX-FY-000001  (e.g. SO-2526-000001)

export function financialYearOf(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = d.getMonth() + 1
  const start = m >= 4 ? y : y - 1
  const end = start + 1
  return `${String(start % 100).padStart(2, '0')}${String(end % 100).padStart(2, '0')}`
}

export const DOC_PREFIX: Record<string, string> = {
  ENQ: 'ENQ', QT: 'QT', SO: 'SO', DN: 'DN', INV: 'INV',
  PR: 'PR', PO: 'PO', GRN: 'GRN', PINV: 'PINV',
  WO: 'WO', MI: 'MI', QC: 'QC',
  RCPT: 'RCPT', PYMT: 'PYMT', EXP: 'EXP', TRF: 'TRF', ADJ: 'ADJ',
}

/**
 * Atomically generate next document number for (companyId, docType, FY).
 * Must be called inside the same transaction/interactive tx as record creation.
 */
export async function nextDocNumber(tx: {
  numberSeq: {
    findUnique: (a: unknown) => Promise<{ nextNumber: number } | null>
    create: (a: unknown) => Promise<unknown>
    update: (a: unknown) => Promise<unknown>
  }
}, companyId: string, docType: string, date: Date = new Date()): Promise<string> {
  const fy = financialYearOf(date)
  const prefix = DOC_PREFIX[docType] || docType
  const existing = await tx.numberSeq.findUnique({
    where: { companyId_docType_financialYear: { companyId, docType, financialYear: fy } },
  })
  let n: number
  if (existing) {
    await tx.numberSeq.update({ where: { companyId_docType_financialYear: { companyId, docType, financialYear: fy } }, data: { nextNumber: { increment: 1 } } })
    n = existing.nextNumber
  } else {
    await tx.numberSeq.create({ data: { companyId, docType, prefix, financialYear: fy, nextNumber: 2 } })
    n = 1
  }
  return `${prefix}-${fy}-${String(n).padStart(6, '0')}`
}

// ============ GST helpers ============

export interface TaxLine {
  qty: number; rate: number; discountPct?: number; gstRate: number
}

/** Compute per-line taxable value and tax split. interState => IGST, else CGST+SGST */
export function computeGst(lines: TaxLine[], interState: boolean) {
  let subtotal = 0, discountTotal = 0, cgst = 0, sgst = 0, igst = 0
  const computed = lines.map((l) => {
    const gross = l.qty * l.rate
    const disc = gross * ((l.discountPct || 0) / 100)
    const taxable = gross - disc
    const tax = taxable * (l.gstRate / 100)
    subtotal += gross
    discountTotal += disc
    if (interState) igst += tax
    else { cgst += tax / 2; sgst += tax / 2 }
    return { ...l, taxable, tax }
  })
  const grandTotal = subtotal - discountTotal + cgst + sgst + igst
  return { computed, subtotal: r2(subtotal), discountTotal: r2(discountTotal), cgst: r2(cgst), sgst: r2(sgst), igst: r2(igst), grandTotal: r2(grandTotal) }
}

export const r2 = (n: number) => Math.round(n * 100) / 100

/** isInterState if company stateCode differs from party stateCode */
export function isInterState(companyState?: string | null, partyState?: string | null): boolean {
  if (!companyState || !partyState) return false
  return companyState !== partyState
}

// ============ Stock posting (immutable ledger) ============

export interface StockPostInput {
  companyId: string
  itemId: string
  warehouseId: string
  type: string
  qtyIn?: number
  qtyOut?: number
  rate?: number
  date?: Date
  refType?: string
  refId?: string
  refNumber?: string
  notes?: string
}

interface MinimalTx {
  stockLedger: { create: (a: unknown) => Promise<unknown> }
  stockBalance: {
    findUnique: (a: unknown) => Promise<{ id: string; qty: number; avgRate: number } | null>
    upsert: (a: unknown) => Promise<unknown>
    update: (a: unknown) => Promise<unknown>
  }
  notification: { create: (a: unknown) => Promise<unknown> }
  item: { findUnique: (a: unknown) => Promise<{ id: string; name: string; code: string; reorderLevel: number; uom: string } | null> }
}

/**
 * Post a stock movement: writes immutable StockLedger row + updates StockBalance (moving average rate).
 * Call inside a prisma $transaction. Returns updated balance qty.
 */
export async function postStock(tx: MinimalTx, input: StockPostInput): Promise<number> {
  const qtyIn = Math.max(0, input.qtyIn || 0)
  const qtyOut = Math.max(0, input.qtyOut || 0)
  const rate = input.rate || 0
  const date = input.date || new Date()

  const bal = await tx.stockBalance.findUnique({
    where: { itemId_warehouseId: { itemId: input.itemId, warehouseId: input.warehouseId } },
  })
  const prevQty = bal?.qty || 0
  const prevRate = bal?.avgRate || 0
  const newQty = r2(prevQty + qtyIn - qtyOut)

  let newRate = prevRate
  if (qtyIn > 0 && rate > 0) {
    newRate = r2((prevQty * prevRate + qtyIn * rate) / (prevQty + qtyIn))
  } else if (prevQty <= 0 && qtyIn === 0) {
    newRate = rate
  }

  await tx.stockLedger.create({
    data: {
      companyId: input.companyId, date, itemId: input.itemId, warehouseId: input.warehouseId,
      type: input.type, qtyIn, qtyOut, rate, refType: input.refType, refId: input.refId,
      refNumber: input.refNumber, notes: input.notes,
    },
  })

  if (bal) {
    await tx.stockBalance.update({ where: { id: bal.id }, data: { qty: newQty, avgRate: newRate } })
  } else {
    await tx.stockBalance.upsert({
      where: { itemId_warehouseId: { itemId: input.itemId, warehouseId: input.warehouseId } },
      create: { companyId: input.companyId, itemId: input.itemId, warehouseId: input.warehouseId, qty: newQty, avgRate: newRate },
      update: { qty: newQty, avgRate: newRate },
    })
  }

  // Low-stock notification on outward movement
  if (qtyOut > 0) {
    const item = await tx.item.findUnique({ where: { id: input.itemId } })
    if (item && item.reorderLevel > 0 && newQty <= item.reorderLevel) {
      const openCount = await (tx as unknown as { notification: { count: (a: unknown) => Promise<number> } }).notification.count({
        where: { companyId: input.companyId, read: false, title: { contains: 'Low stock' } },
      })
      if (openCount < 20) {
        await tx.notification.create({
          data: {
            companyId: input.companyId,
            title: `Low stock: ${item.name}`,
            message: `${item.code} is at ${newQty} ${item.uom} (reorder level ${item.reorderLevel}). Raise a purchase requisition.`,
            level: newQty <= 0 ? 'CRITICAL' : 'WARNING',
          },
        })
      }
    }
  }

  return newQty
}

/** Available qty across all warehouses for an item (within tx). */
export async function availableQty(tx: {
  stockBalance: { findMany: (a: unknown) => Promise<{ qty: number }[]> }
}, companyId: string, itemId: string, excludeWarehouseId?: string): Promise<number> {
  const rows = await tx.stockBalance.findMany({ where: { companyId, itemId, ...(excludeWarehouseId ? { warehouseId: { not: excludeWarehouseId } } : {}) } })
  return r2(rows.reduce((s, r) => s + r.qty, 0))
}

// ============ Audit + notifications ============

export async function logAudit(tx: {
  auditLog: { create: (a: unknown) => Promise<unknown> }
}, input: { companyId: string; userName?: string; action: string; entity: string; entityId?: string; details?: string }) {
  await tx.auditLog.create({
    data: {
      companyId: input.companyId, userName: input.userName || 'system', action: input.action,
      entity: input.entity, entityId: input.entityId, details: input.details,
    },
  })
}

export async function notify(tx: {
  notification: { create: (a: unknown) => Promise<unknown> }
}, input: { companyId: string; title: string; message?: string; level?: string }) {
  await tx.notification.create({
    data: { companyId: input.companyId, title: input.title, message: input.message, level: input.level || 'INFO' },
  })
}
