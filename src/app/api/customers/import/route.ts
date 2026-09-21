import { db } from '@/lib/db'
import { ApiError, companyRequired, handleError, logAudit, ok, requireWrite } from '@/lib/erp-helpers'

type Row = Record<string, string>

interface RowError {
  row: number
  message: string
}

interface PreparedCustomer {
  row: number
  code: string
  name: string
  gstin: string | null
  city: string | null
  state: string | null
  stateCode: string | null
  phone: string | null
  email: string | null
  addressLine: string | null
}

function cell(row: Row, key: string): string {
  const v = row[key]
  return (v === undefined || v === null ? '' : String(v)).trim()
}

// ============================== POST /api/customers/import ==============================
// Body: { companyId, rows: Array<Record<string,string>> }
// Headers (case-insensitive, matched by the client): name, gstin, city, state,
// stateCode, phone, email, addressLine. Optional extra column: code.
// Customer codes are auto-allocated (CUST-0001…) when not provided.
export async function POST(req: Request) {
  try {
    const actor = requireWrite(req, 'customers')
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const companyId = await companyRequired(req, typeof body.companyId === 'string' ? body.companyId : undefined)

    if (!Array.isArray(body.rows) || body.rows.length === 0) throw new ApiError('rows array is required', 400)
    if (body.rows.length > 500) throw new ApiError('Maximum 500 rows per import', 400)
    const rawRows = body.rows as unknown[]

    const existing = await db.customer.findMany({ where: { companyId }, select: { code: true, name: true } })
    const codes = new Set<string>()
    const names = new Set<string>()
    let maxCodeNum = 0
    for (const c of existing) {
      codes.add(c.code.toUpperCase())
      names.add(c.name.trim().toLowerCase())
      const m = /^CUST-(\d+)$/i.exec(c.code)
      if (m) maxCodeNum = Math.max(maxCodeNum, Number(m[1]))
    }
    let nextNum = maxCodeNum + 1
    const allocateCode = (): string => {
      let candidate = `CUST-${String(nextNum).padStart(4, '0')}`
      while (codes.has(candidate)) {
        nextNum++
        candidate = `CUST-${String(nextNum).padStart(4, '0')}`
      }
      codes.add(candidate)
      nextNum++
      return candidate
    }

    const errors: RowError[] = []
    const seenNames = new Set<string>()
    const prepared: PreparedCustomer[] = []
    let skipped = 0

    rawRows.forEach((raw, i) => {
      const rowNo = i + 1
      const row = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Row
      const name = cell(row, 'name')
      if (!name) {
        errors.push({ row: rowNo, message: 'name is required' })
        return
      }
      const gstin = cell(row, 'gstin').toUpperCase()
      if (gstin && gstin.length !== 15) {
        errors.push({ row: rowNo, message: `Invalid GSTIN ${gstin} — must be 15 characters` })
        return
      }
      const lower = name.toLowerCase()
      if (names.has(lower) || seenNames.has(lower)) {
        errors.push({ row: rowNo, message: `Duplicate name ${name} — skipped` })
        skipped++
        return
      }
      seenNames.add(lower)
      let code = cell(row, 'code').toUpperCase()
      if (code) {
        if (codes.has(code)) {
          errors.push({ row: rowNo, message: `Duplicate code ${code} — skipped` })
          skipped++
          return
        }
        codes.add(code)
      } else {
        code = allocateCode()
      }
      prepared.push({
        row: rowNo,
        code,
        name,
        gstin: gstin || null,
        city: cell(row, 'city') || null,
        state: cell(row, 'state') || null,
        stateCode: cell(row, 'stateCode') || null,
        phone: cell(row, 'phone') || null,
        email: cell(row, 'email') || null,
        addressLine: cell(row, 'addressLine') || null,
      })
    })

    let imported = 0
    if (prepared.length > 0) {
      await db.$transaction(async (tx) => {
        for (const p of prepared) {
          try {
            await tx.customer.create({
              data: {
                companyId,
                code: p.code,
                name: p.name,
                gstin: p.gstin,
                city: p.city,
                state: p.state,
                stateCode: p.stateCode,
                phone: p.phone,
                email: p.email,
                addressLine: p.addressLine,
                status: 'ACTIVE',
              },
            })
            imported++
          } catch (e) {
            errors.push({ row: p.row, message: e instanceof Error ? e.message : 'Failed to create customer' })
          }
        }
      })
    }

    try {
      await logAudit(db as never, {
        companyId,
        userName: actor.userName,
        action: 'IMPORT',
        entity: 'CUSTOMER',
        details: `CSV import: ${imported} customers`,
      })
    } catch {
      // audit is best-effort
    }

    return ok({ imported, skipped, errors }, `Imported ${imported} customers`)
  } catch (e) {
    return handleError(e)
  }
}
