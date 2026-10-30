import { escapeHtml as esc } from '@/lib/html'
import { fmtMoney } from '@/lib/erp-constants'

export interface PrintQuotation {
  number: string; date: string; validUntil?: string | null; status: string
  subtotal: number; discountTotal: number; cgst: number; sgst: number; igst: number; grandTotal: number
  notes?: string | null; kindAttn?: string | null; paymentTerms?: string | null; deliveryTerms?: string | null; terms?: string | null
  customer?: { name?: string | null; city?: string | null; state?: string | null; gstin?: string | null } | null
  items?: { itemId: string; qty: number; rate: number; discountPct: number; gstRate: number; lineTotal: number; item?: { name?: string | null } | null }[] | null
}

export interface PrintSeller { name?: string | null; gstin?: string | null }

/**
 * Body of the printed quotation. Everything a user typed (party, item, terms) is escaped: the print
 * window runs on the app's origin, so raw text here would be a stored XSS. The header is the
 * tenant's own company, never a fixed name.
 */
export function quotationPrintHtml(q: PrintQuotation, seller?: PrintSeller | null): string {
  const c = q.customer
  const rows = (q.items ?? []).map((it, i) =>
    `<tr><td>${i + 1}</td><td>${esc(it.item?.name || it.itemId)}</td><td class="num">${esc(it.qty)}</td><td class="num">${fmtMoney(it.rate)}</td><td class="num">${esc(it.discountPct)}%</td><td class="num">${esc(it.gstRate)}%</td><td class="num">${fmtMoney(it.lineTotal)}</td></tr>`,
  ).join('')
  return `
      <div class="head">
        <div><h1>${esc(seller?.name || 'Quotation')}</h1>
          <div class="muted">${seller?.gstin ? `GSTIN ${esc(seller.gstin)} · ` : ''}Quotation · ${esc(q.number)}</div></div>
        <div style="text-align:right"><span class="badge">${esc(q.status)}</span><br/>
          <div class="muted">Date: ${esc(new Date(q.date).toLocaleDateString('en-IN'))}</div>
          ${q.validUntil ? `<div class="muted">Valid until: ${esc(new Date(q.validUntil).toLocaleDateString('en-IN'))}</div>` : ''}</div>
      </div>
      <p><strong>To:</strong> ${esc(c?.name || '—')}${c?.gstin ? ` · GSTIN ${esc(c.gstin)}` : ''}
      ${c?.city ? `<br/><span class="muted">${esc(c.city)}${c.state ? ', ' + esc(c.state) : ''}</span>` : ''}
      ${q.kindAttn ? `<br/><strong>Kind Attn:</strong> ${esc(q.kindAttn)}` : ''}</p>
      <table>
        <thead><tr><th>#</th><th>Item</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Disc %</th><th class="num">GST %</th><th class="num">Amount</th></tr></thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
      <table class="totals" style="width:280px;margin-left:auto">
        <tr><td>Subtotal</td><td class="num">${fmtMoney(q.subtotal)}</td></tr>
        <tr><td>Discount</td><td class="num">- ${fmtMoney(q.discountTotal)}</td></tr>
        <tr><td>CGST</td><td class="num">${fmtMoney(q.cgst)}</td></tr>
        <tr><td>SGST</td><td class="num">${fmtMoney(q.sgst)}</td></tr>
        ${q.igst ? `<tr><td>IGST</td><td class="num">${fmtMoney(q.igst)}</td></tr>` : ''}
        <tr class="grand"><td>Grand Total</td><td class="num">${fmtMoney(q.grandTotal)}</td></tr>
      </table>
      ${q.notes ? `<p class="muted">Notes: ${esc(q.notes)}</p>` : ''}
      ${q.paymentTerms ? `<p><strong>Payment Terms:</strong> ${esc(q.paymentTerms)}</p>` : ''}
      ${q.deliveryTerms ? `<p><strong>Delivery Terms:</strong> ${esc(q.deliveryTerms)}</p>` : ''}
      ${q.terms ? `<div style="margin-top:10px"><strong>Terms &amp; Conditions</strong><div style="white-space:pre-wrap;font-size:11px;margin-top:4px">${esc(q.terms)}</div></div>` : ''}
      <p class="muted">This is a computer generated quotation. Prices valid as per validity date above.</p>`
}
