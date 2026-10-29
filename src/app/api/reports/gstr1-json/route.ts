import { db } from '@/lib/db'
import { ok, handleError, companyRequired, ApiError, r2, requireRead } from '@/lib/erp-helpers'
import { endOfDayStr, stateCodeOf } from '@/lib/accounting'

// GET /api/reports/gstr1-json?companyId=&month=YYYY-MM
// Best-effort GSTR-1 JSON shaped like the GSTN offline tool import:
//   { gstin, fp: "MMYYYY", version, hash, b2b, b2cl, b2cs, cdnr, hsn }
//   b2b  — invoices to customers with a GSTIN, rate-wise items (rt, txval, iamt, camt, samt, csamt)
//   b2cl — inter-state invoices to unregistered buyers with invoice value > B2CL_THRESHOLD,
//          grouped by place of supply (rt, txval, iamt, csamt per rate)
//   b2cs — all other unregistered sales grouped by place of supply + rate
//   cdnr — credit notes (sales returns) to registered customers
//   hsn  — HSN-wise summary of outward supplies
// Freight / packing are added as taxable value at their own GST rate. Review in the offline tool before upload.

/**
 * B2CL limit: inter-state B2C invoices with an invoice value ABOVE this go to table 5 (b2cl).
 * ₹1,00,000 from 1 Aug 2024 (Notification 12/2024-CT); it was ₹2,50,000 before that.
 */
const B2CL_THRESHOLD = 100000

interface Bucket { rt: number; txval: number; iamt: number; camt: number; samt: number; csamt: number }

const ddmmyyyy = (d: Date) => `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`

function addTo(map: Map<number, Bucket>, rt: number, txval: number, inter: boolean, cess = 0) {
  const b = map.get(rt) ?? { rt, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 }
  const tax = (txval * rt) / 100
  b.txval += txval
  if (inter) b.iamt += tax
  else { b.camt += tax / 2; b.samt += tax / 2 }
  b.csamt += cess
  map.set(rt, b)
}
const roundB = (b: Bucket): Bucket => ({ rt: b.rt, txval: r2(b.txval), iamt: r2(b.iamt), camt: r2(b.camt), samt: r2(b.samt), csamt: r2(b.csamt) })
const itms = (m: Map<number, Bucket>) =>
  [...m.values()].sort((a, b) => a.rt - b.rt).map((b, i) => ({ num: i + 1, itm_det: roundB(b) }))

export async function GET(req: Request) {
  try {
    requireRead(req, 'gst-report') // Phase 5: financial read permission
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const now = new Date()
    const month = searchParams.get('month') || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const m = /^(\d{4})-(\d{2})$/.exec(month)
    if (!m) throw new ApiError('month must be YYYY-MM', 400)
    const y = Number(m[1])
    const mo = Number(m[2])
    if (mo < 1 || mo > 12) throw new ApiError('month must be YYYY-MM', 400)
    const from = new Date(`${month}-01`)
    const lastDay = new Date(y, mo, 0).getDate()
    const to = endOfDayStr(`${month}-${String(lastDay).padStart(2, '0')}`)
    const date = { gte: from, lte: to }

    const company = await db.company.findUnique({ where: { id: companyId }, select: { gstin: true, stateCode: true, state: true } })
    const ownState = company?.stateCode || company?.gstin?.slice(0, 2) || stateCodeOf(company?.state) || ''

    const [invoices, returns] = await Promise.all([
      db.salesInvoice.findMany({
        where: { companyId, status: { not: 'CANCELLED' }, date },
        orderBy: { date: 'asc' },
        include: {
          items: { select: { itemId: true, hsn: true, qty: true, gstRate: true, cessRate: true, lineTotal: true } },
          customer: { select: { gstin: true, stateCode: true, state: true } },
        },
      }),
      db.salesReturn.findMany({
        where: { companyId, status: { not: 'CANCELLED' }, date },
        orderBy: { date: 'asc' },
        include: { items: { select: { itemId: true, qty: true, gstRate: true, lineTotal: true } } },
      }),
    ])
    const custIds = [...new Set(returns.map((r) => r.customerId))]
    const itemIds = [...new Set(invoices.flatMap((i) => i.items.map((l) => l.itemId)))]
    const [retCustomers, masters] = await Promise.all([
      custIds.length ? db.customer.findMany({ where: { companyId, id: { in: custIds } }, select: { id: true, gstin: true, stateCode: true, state: true } }) : [],
      itemIds.length ? db.item.findMany({ where: { companyId, id: { in: itemIds } }, select: { id: true, name: true, hsn: true, uom: true } }) : [],
    ])
    const custMap = new Map(retCustomers.map((c) => [c.id, c] as const))
    const itemMap = new Map(masters.map((i) => [i.id, i] as const))

    const posOf = (p: { stateCode?: string | null; gstin?: string | null; state?: string | null } | null | undefined, placeOfSupply?: string | null) =>
      p?.stateCode || p?.gstin?.slice(0, 2) || stateCodeOf(placeOfSupply) || stateCodeOf(p?.state) || ownState

    const b2bMap = new Map<string, { ctin: string; inv: unknown[] }>()
    const b2clMap = new Map<string, { pos: string; inv: { inum: string; idt: string; val: number; itms: { num: number; itm_det: { rt: number; txval: number; iamt: number; csamt: number } }[] }[] }>()
    const b2csMap = new Map<string, { sply_ty: string; pos: string; typ: string; rt: number; txval: number; iamt: number; camt: number; samt: number; csamt: number }>()
    const hsnMap = new Map<string, { hsn_sc: string; desc: string; uqc: string; qty: number; rt: number; txval: number; iamt: number; camt: number; samt: number; csamt: number }>()

    for (const inv of invoices) {
      const inter = inv.isInterState
      const rates = new Map<number, Bucket>()
      for (const l of inv.items) {
        const cess = ((l.lineTotal || 0) * (l.cessRate || 0)) / 100
        addTo(rates, l.gstRate || 0, l.lineTotal || 0, inter, cess)
        const master = itemMap.get(l.itemId)
        const hsn = l.hsn || master?.hsn || 'NA'
        const key = `${hsn}|${l.gstRate || 0}`
        const h = hsnMap.get(key) ?? { hsn_sc: hsn, desc: master?.name || '', uqc: (master?.uom || 'OTH').slice(0, 3).toUpperCase(), qty: 0, rt: l.gstRate || 0, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 }
        const tax = ((l.lineTotal || 0) * (l.gstRate || 0)) / 100
        h.qty += l.qty || 0
        h.txval += l.lineTotal || 0
        if (inter) h.iamt += tax
        else { h.camt += tax / 2; h.samt += tax / 2 }
        h.csamt += cess
        hsnMap.set(key, h)
      }
      if (inv.freightCharge > 0) addTo(rates, inv.freightGstRate, inv.freightCharge, inter)
      if (inv.packingCharge > 0) addTo(rates, inv.packingGstRate, inv.packingCharge, inter)
      const pos = posOf(inv.customer, inv.placeOfSupply)
      const gstin = inv.customer?.gstin
      if (gstin) {
        const g = b2bMap.get(gstin) ?? { ctin: gstin, inv: [] }
        g.inv.push({ inum: inv.number, idt: ddmmyyyy(inv.date), val: r2(inv.grandTotal), pos, rchrg: 'N', inv_typ: 'R', itms: itms(rates) })
        b2bMap.set(gstin, g)
      } else if (inter && inv.grandTotal > B2CL_THRESHOLD) {
        // No GSTIN → unregistered buyer (gstType UNREGISTERED / CONSUMER). The registered test stays GSTIN-based like b2b:
        // gstType defaults to UNREGISTERED, so older customers with a GSTIN may still carry it.
        const g = b2clMap.get(pos) ?? { pos, inv: [] }
        g.inv.push({
          inum: inv.number, idt: ddmmyyyy(inv.date), val: r2(inv.grandTotal),
          itms: itms(rates).map((x) => ({ num: x.num, itm_det: { rt: x.itm_det.rt, txval: x.itm_det.txval, iamt: x.itm_det.iamt, csamt: x.itm_det.csamt } })),
        })
        b2clMap.set(pos, g)
      } else {
        for (const b of rates.values()) {
          const key = `${pos}|${b.rt}|${inter ? 'INTER' : 'INTRA'}`
          const row = b2csMap.get(key) ?? { sply_ty: inter ? 'INTER' : 'INTRA', pos, typ: 'OE', rt: b.rt, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 }
          row.txval += b.txval; row.iamt += b.iamt; row.camt += b.camt; row.samt += b.samt; row.csamt += b.csamt
          b2csMap.set(key, row)
        }
      }
    }

    const cdnrMap = new Map<string, { ctin: string; nt: unknown[] }>()
    let unregisteredCreditNotes = 0
    for (const r of returns) {
      const c = custMap.get(r.customerId)
      if (!c?.gstin) { unregisteredCreditNotes += 1; continue }
      const rates = new Map<number, Bucket>()
      for (const l of r.items) addTo(rates, l.gstRate || 0, l.lineTotal || 0, r.isInterState)
      const g = cdnrMap.get(c.gstin) ?? { ctin: c.gstin, nt: [] as unknown[] }
      g.nt.push({ ntty: 'C', nt_num: r.number, nt_dt: ddmmyyyy(r.date), val: r2(r.grandTotal), pos: posOf(c), rchrg: 'N', inv_typ: 'R', itms: itms(rates) })
      cdnrMap.set(c.gstin, g)
    }

    const rr = <T extends { txval: number; iamt: number; camt: number; samt: number; csamt: number }>(o: T): T =>
      ({ ...o, txval: r2(o.txval), iamt: r2(o.iamt), camt: r2(o.camt), samt: r2(o.samt), csamt: r2(o.csamt) })

    const json = {
      gstin: company?.gstin || '',
      fp: `${String(mo).padStart(2, '0')}${y}`,
      version: 'GST3.0.4',
      hash: 'hash',
      b2b: [...b2bMap.values()],
      b2cl: [...b2clMap.values()],
      b2cs: [...b2csMap.values()].map(rr),
      cdnr: [...cdnrMap.values()],
      hsn: { data: [...hsnMap.values()].map((h, i) => ({ num: i + 1, ...rr(h), qty: r2(h.qty) })) },
    }
    return ok({
      json,
      summary: {
        invoices: invoices.length,
        b2bInvoices: json.b2b.reduce((s, g) => s + g.inv.length, 0),
        b2clInvoices: json.b2cl.reduce((s, g) => s + g.inv.length, 0),
        b2csRows: json.b2cs.length,
        creditNotes: returns.length - unregisteredCreditNotes,
        unregisteredCreditNotes,
        hsnRows: json.hsn.data.length,
        missingGstin: !company?.gstin,
      },
    })
  } catch (e) {
    return handleError(e)
  }
}
