import { db } from '@/lib/db'
import { requireWrite, ok, handleError, companyRequired, ApiError, logAudit, assertLimit } from '@/lib/erp-helpers'

const MAX_ATTRS = 3
const MAX_VALUES = 30
const MAX_COMBOS = 200

/** Canonical key for a variant's attributes: keys + values case-insensitive, key order ignored. */
function attrKey(attrs: Record<string, string>): string {
  return Object.keys(attrs)
    .map((k) => [k.trim().toLowerCase(), String(attrs[k]).trim().toLowerCase()] as const)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}=${v}`)
    .join('|')
}

function parseAttrs(raw: string | null): Record<string, string> | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, String(x)]))
  } catch {
    return null
  }
}

const codePart = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]+/g, '')

// ============================== GET /api/items/[id]/variants ==============================
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const companyId = await companyRequired(req)
    const parent = await db.item.findFirst({ where: { id, companyId }, select: { id: true } })
    if (!parent) throw new ApiError('Item not found', 404)
    const items = await db.item.findMany({
      where: { companyId, variantOf: id },
      orderBy: { code: 'asc' },
      select: { id: true, code: true, name: true, variantAttrs: true, status: true },
    })
    return ok({ items, total: items.length })
  } catch (e) {
    return handleError(e)
  }
}

// ============================== POST /api/items/[id]/variants ==============================
// Body: { attributes: { Size: ['S','M','L'], Color: ['Red','Blue'] } }
// Creates one child item per combination; combinations that already exist are skipped.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = requireWrite(req, 'items')
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body.companyId)
    const parent = await db.item.findFirst({ where: { id, companyId } })
    if (!parent) throw new ApiError('Item not found', 404)
    if (parent.variantOf) throw new ApiError('This item is itself a variant — create variants on its parent item', 400)

    // ---- validate attributes ----
    const rawAttrs = body.attributes
    if (!rawAttrs || typeof rawAttrs !== 'object' || Array.isArray(rawAttrs)) {
      throw new ApiError('attributes must be an object like { Size: ["S","M"] }', 400)
    }
    const attrs: { name: string; values: string[] }[] = []
    const seenNames = new Set<string>()
    for (const [k, v] of Object.entries(rawAttrs as Record<string, unknown>)) {
      const name = String(k).trim()
      if (!name) continue
      if (name.length > 30) throw new ApiError(`Attribute name too long: ${name.slice(0, 30)}…`, 400)
      if (seenNames.has(name.toLowerCase())) throw new ApiError(`Duplicate attribute: ${name}`, 400)
      seenNames.add(name.toLowerCase())
      if (!Array.isArray(v)) throw new ApiError(`${name}: values must be a list`, 400)
      const values: string[] = []
      const seenVals = new Set<string>()
      for (const x of v) {
        const val = String(x ?? '').trim()
        if (!val) continue
        if (val.length > 30) throw new ApiError(`${name}: value too long (${val.slice(0, 30)}…)`, 400)
        if (seenVals.has(val.toLowerCase())) continue
        seenVals.add(val.toLowerCase())
        values.push(val)
      }
      if (values.length === 0) throw new ApiError(`${name}: add at least one value`, 400)
      if (values.length > MAX_VALUES) throw new ApiError(`${name}: at most ${MAX_VALUES} values`, 400)
      attrs.push({ name, values })
    }
    if (attrs.length === 0) throw new ApiError('Add at least one attribute with values', 400)
    if (attrs.length > MAX_ATTRS) throw new ApiError(`At most ${MAX_ATTRS} attributes`, 400)

    // ---- cartesian product ----
    let combos: Record<string, string>[] = [{}]
    for (const a of attrs) {
      const next: Record<string, string>[] = []
      for (const c of combos) for (const v of a.values) next.push({ ...c, [a.name]: v })
      combos = next
      if (combos.length > MAX_COMBOS) throw new ApiError(`Too many combinations (max ${MAX_COMBOS})`, 400)
    }

    // ---- skip combinations that already exist ----
    const [children, allCodes] = await Promise.all([
      db.item.findMany({ where: { companyId, variantOf: parent.id }, select: { variantAttrs: true } }),
      db.item.findMany({ where: { companyId }, select: { code: true } }),
    ])
    const existingKeys = new Set(children.map((c) => parseAttrs(c.variantAttrs)).filter((a): a is Record<string, string> => !!a).map(attrKey))
    const takenCodes = new Set(allCodes.map((c) => c.code.toUpperCase()))
    const toCreate = combos.filter((c) => !existingKeys.has(attrKey(c)))
    const skipped = combos.length - toCreate.length
    if (toCreate.length === 0) return ok({ created: 0, skipped, items: [] }, 'All these variants already exist')

    await assertLimit(companyId, 'items', toCreate.length)

    const rows = toCreate.map((c) => {
      const vals = attrs.map((a) => c[a.name])
      const base = [parent.code, ...vals.map(codePart).filter(Boolean)].join('-')
      let code = base
      for (let n = 2; takenCodes.has(code.toUpperCase()); n++) code = `${base}-${n}`
      takenCodes.add(code.toUpperCase())
      return {
        companyId,
        code,
        name: `${parent.name} - ${vals.join(' / ')}`,
        type: parent.type,
        category: parent.category,
        uom: parent.uom,
        altUom: parent.altUom,
        altFactor: parent.altFactor,
        hsn: parent.hsn,
        gstRate: parent.gstRate,
        cessRate: parent.cessRate,
        purchasePrice: parent.purchasePrice,
        sellingPrice: parent.sellingPrice,
        standardCost: parent.standardCost,
        mrp: parent.mrp,
        priceIncludesTax: parent.priceIncludesTax,
        batchTracked: parent.batchTracked,
        trackSerial: parent.trackSerial,
        reorderLevel: parent.reorderLevel,
        minStock: parent.minStock,
        maxStock: parent.maxStock,
        brand: parent.brand,
        leadTimeDays: parent.leadTimeDays,
        status: 'ACTIVE',
        variantOf: parent.id,
        variantAttrs: JSON.stringify(c),
      }
    })

    const created = await db.$transaction(async (tx) => {
      const out: { id: string; code: string; name: string }[] = []
      for (const data of rows) {
        const it = await tx.item.create({ data, select: { id: true, code: true, name: true } })
        out.push(it)
      }
      await logAudit(tx as any, {
        companyId,
        userName: actor.userName,
        action: 'CREATE',
        entity: 'Item',
        entityId: parent.id,
        details: `${parent.code}: ${out.length} variant(s) created (${attrs.map((a) => a.name).join(' × ')})`,
      })
      return out
    })

    return ok({ created: created.length, skipped, items: created }, `${created.length} variant(s) created${skipped ? `, ${skipped} already existed` : ''}`)
  } catch (e) {
    return handleError(e)
  }
}
