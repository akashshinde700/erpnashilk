import { db } from '@/lib/db'
import { ApiError, companyRequired, handleError, logAudit, ok, postStock, requireWrite } from '@/lib/erp-helpers'
import { ITEM_TYPES, UOMS } from '@/lib/erp-constants'

type Row = Record<string, string>

interface RowError {
  row: number
  message: string
}

interface PreparedItem {
  row: number
  code: string
  name: string
  type: string
  uom: string
  standardCost: number
  sellingPrice: number
  reorderLevel: number
  openingStock: number
  status: string
}

function cell(row: Row, key: string): string {
  const v = row[key]
  return (v === undefined || v === null ? '' : String(v)).trim()
}

function numOr0(v: string, field: string, rowNo: number, errors: RowError[]): number {
  if (!v) return 0
  const n = Number(v)
  if (Number.isNaN(n)) {
    errors.push({ row: rowNo, message: `${field} must be a number` })
    return 0
  }
  return n
}

// ============================== POST /api/items/import ==============================
// Body: { companyId, rows: Array<Record<string,string>> }
// Headers (case-insensitive, matched by the client): code, name, type, uom,
// standardCost, sellPrice, reorderLevel, openingStock
export async function POST(req: Request) {
  try {
    const actor = requireWrite(req, 'items')
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const companyId = await companyRequired(req, typeof body.companyId === 'string' ? body.companyId : undefined)

    if (!Array.isArray(body.rows) || body.rows.length === 0) throw new ApiError('rows array is required', 400)
    if (body.rows.length > 500) throw new ApiError('Maximum 500 rows per import', 400)
    const rawRows = body.rows as unknown[]

    // Default warehouse (code asc) for optional opening stock + existing codes for dupe skips
    const [warehouse, existingItems] = await Promise.all([
      db.warehouse.findFirst({ where: { companyId }, orderBy: { code: 'asc' } }),
      db.item.findMany({ where: { companyId }, select: { code: true } }),
    ])
    const existingCodes = new Set(existingItems.map((i) => i.code.toUpperCase()))

    const errors: RowError[] = []
    const seenCodes = new Set<string>()
    const prepared: PreparedItem[] = []
    let skipped = 0

    rawRows.forEach((raw, i) => {
      const rowNo = i + 1
      const row = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Row
      const code = cell(row, 'code').toUpperCase()
      const name = cell(row, 'name')
      if (!code) {
        errors.push({ row: rowNo, message: 'code is required' })
        return
      }
      if (!name) {
        errors.push({ row: rowNo, message: 'name is required' })
        return
      }
      const type = (cell(row, 'type') || 'RAW').toUpperCase()
      if (!(ITEM_TYPES as readonly string[]).includes(type)) {
        errors.push({ row: rowNo, message: `Invalid type ${type} — must be one of ${ITEM_TYPES.join(', ')}` })
        return
      }
      const uom = (cell(row, 'uom') || 'NOS').toUpperCase()
      if (!(UOMS as readonly string[]).includes(uom)) {
        errors.push({ row: rowNo, message: `Invalid uom ${uom} — must be one of ${UOMS.join(', ')}` })
        return
      }
      const before = errors.length
      const standardCost = numOr0(cell(row, 'standardCost'), 'standardCost', rowNo, errors)
      const sellingPrice = numOr0(cell(row, 'sellPrice'), 'sellPrice', rowNo, errors)
      const reorderLevel = numOr0(cell(row, 'reorderLevel'), 'reorderLevel', rowNo, errors)
      const openingStock = numOr0(cell(row, 'openingStock'), 'openingStock', rowNo, errors)
      if (errors.length > before) return
      const status = cell(row, 'status').toUpperCase() === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE'
      if (openingStock > 0 && !warehouse) {
        errors.push({ row: rowNo, message: 'openingStock provided but the company has no warehouse' })
        return
      }
      if (existingCodes.has(code) || seenCodes.has(code)) {
        errors.push({ row: rowNo, message: `Duplicate code ${code} — skipped` })
        skipped++
        return
      }
      seenCodes.add(code)
      prepared.push({ row: rowNo, code, name, type, uom, standardCost, sellingPrice, reorderLevel, openingStock, status })
    })

    let imported = 0
    if (prepared.length > 0) {
      await db.$transaction(async (tx) => {
        for (const p of prepared) {
          try {
            const created = await tx.item.create({
              data: {
                companyId,
                code: p.code,
                name: p.name,
                type: p.type,
                uom: p.uom,
                standardCost: p.standardCost,
                sellingPrice: p.sellingPrice,
                reorderLevel: p.reorderLevel,
                status: p.status,
              },
            })
            // Mirror items POST opening-stock behavior (type OPENING / refType OPENING)
            if (p.openingStock > 0 && warehouse) {
              await postStock(tx as never, {
                companyId,
                itemId: created.id,
                warehouseId: warehouse.id,
                type: 'OPENING',
                qtyIn: p.openingStock,
                rate: p.standardCost,
                refType: 'OPENING',
                notes: 'Opening stock',
              })
            }
            imported++
          } catch (e) {
            errors.push({ row: p.row, message: e instanceof Error ? e.message : 'Failed to create item' })
          }
        }
      })
    }

    try {
      await logAudit(db as never, {
        companyId,
        userName: actor.userName,
        action: 'IMPORT',
        entity: 'ITEM',
        details: `CSV import: ${imported} items`,
      })
    } catch {
      // audit is best-effort
    }

    return ok({ imported, skipped, errors }, `Imported ${imported} items`)
  } catch (e) {
    return handleError(e)
  }
}
