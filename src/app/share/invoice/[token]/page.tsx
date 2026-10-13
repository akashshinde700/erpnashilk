import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import QRCode from 'qrcode'
import { db } from '@/lib/db'
import { amountInWords } from '@/lib/number-to-words'
import PrintButton from './print-button'

// Public, read-only tax invoice opened from a share link (WhatsApp / email).
// No login: the unguessable token is the secret; revoking clears it and this page 404s.
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Tax Invoice',
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
  referrer: 'no-referrer',
}

const money = (n: number | null | undefined) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(n || 0)
const dateIn = (d: Date | string | null | undefined) =>
  d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : ''
const joinParts = (...parts: (string | null | undefined)[]) =>
  parts.filter((p): p is string => !!p && p.trim() !== '').join(', ')
// Only uploaded data: images are rendered (never remote URLs)
const safeImg = (v?: string | null) => (v && /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(v) ? v : '')

export default async function SharedInvoicePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  if (!token || token.length < 16 || token.length > 64) notFound()

  const inv = await db.salesInvoice.findUnique({
    where: { shareToken: token },
    include: { customer: true, items: true, salesOrder: { select: { number: true } } },
  })
  if (!inv || inv.status === 'CANCELLED') notFound()

  const [company, masters, printAccount] = await Promise.all([
    db.company.findUnique({
      where: { id: inv.companyId },
      select: {
        name: true, gstin: true, pan: true, addressLine: true, city: true, state: true, stateCode: true, pincode: true, phone: true, email: true,
        logoImage: true, signatureImage: true, bankAccountName: true, bankAccountNumber: true, bankIfsc: true, bankUpiId: true, bankName: true,
        bankBranch: true, invoiceTerms: true,
      },
    }),
    db.item.findMany({
      where: { companyId: inv.companyId, id: { in: Array.from(new Set(inv.items.map((i) => i.itemId))) } },
      select: { id: true, code: true, name: true, uom: true },
    }),
    db.moneyAccount.findFirst({
      where: { companyId: inv.companyId, type: 'BANK', active: true, printOnInvoice: true },
      select: { name: true, holderName: true, bankName: true, accountNo: true, ifsc: true, branch: true, upiId: true },
    }),
  ])
  if (!company) notFound()
  const itemMap = new Map(masters.map((m) => [m.id, m]))

  const cust = inv.customer
  const buyerName = inv.billingName || cust?.name || '—'
  const interState = (inv.igst || 0) > 0 || inv.isInterState
  const logo = safeImg(company.logoImage)
  const sign = safeImg(company.signatureImage)
  const balance = Math.round(((inv.grandTotal || 0) - (inv.paidAmount || 0)) * 100) / 100
  const bank = {
    holder: company.bankAccountName || printAccount?.holderName || company.name,
    bankName: company.bankName || printAccount?.bankName || '',
    accountNo: company.bankAccountNumber || printAccount?.accountNo || '',
    ifsc: (company.bankIfsc || printAccount?.ifsc || '').toUpperCase(),
    branch: company.bankBranch || printAccount?.branch || '',
    upi: company.bankUpiId || printAccount?.upiId || '',
  }
  const hasBank = !!(bank.accountNo || bank.ifsc || bank.upi)
  const upiLink = bank.upi && balance > 0.005
    ? `upi://pay?pa=${encodeURIComponent(bank.upi)}&pn=${encodeURIComponent(company.name)}&am=${balance.toFixed(2)}&cu=INR&tn=${encodeURIComponent(inv.number)}`
    : ''
  // Same "scan to pay" QR as the printed invoice (generated server-side; skipped when nothing is due)
  const upiQr = upiLink ? await QRCode.toDataURL(upiLink, { margin: 1, width: 180 }).catch(() => '') : ''

  return (
    <div className="si-page">
      <style>{CSS}</style>
      <div className="si-toolbar">
        <span>Tax Invoice {inv.number} from {company.name}</span>
        <PrintButton />
      </div>

      <div className="si-doc">
        <div className="si-title">TAX INVOICE</div>

        <div className="si-head">
          <div className="si-seller">
            {logo && <img className="si-logo" src={logo} alt="" />}
            <div>
              <div className="si-name">{company.name}</div>
              <div className="si-muted">{joinParts(company.addressLine, company.city, company.state, company.pincode)}</div>
              {company.gstin && <div className="si-muted">GSTIN: {company.gstin}{company.pan ? ` · PAN: ${company.pan}` : ''}</div>}
              <div className="si-muted">{joinParts(company.phone, company.email)}</div>
            </div>
          </div>
          <div className="si-meta">
            <div><strong>Invoice No: {inv.number}</strong></div>
            <div className="si-muted">Date: {dateIn(inv.date)}</div>
            {inv.dueDate && <div className="si-muted">Due: {dateIn(inv.dueDate)}</div>}
            {inv.irn && <div className="si-muted si-break">IRN: {inv.irn}</div>}
            {inv.ewayBillNo && <div className="si-muted">E-Way Bill: {inv.ewayBillNo}</div>}
          </div>
        </div>

        <div className="si-grid">
          <div>
            <div className="si-sec">Bill To</div>
            <div className="si-strong">{buyerName}</div>
            {cust && <div className="si-muted">{joinParts(cust.addressLine, cust.city, cust.state, cust.pincode)}</div>}
            {cust?.gstin && <div className="si-muted">GSTIN: {cust.gstin}</div>}
            {cust?.phone && <div className="si-muted">Ph: {cust.phone}</div>}
            {inv.placeOfSupply && <div className="si-muted">Place of Supply: {inv.placeOfSupply}</div>}
            {inv.shippingAddress && (
              <>
                <div className="si-sec" style={{ marginTop: 8 }}>Ship To</div>
                <div className="si-muted si-pre">{inv.shippingAddress}</div>
              </>
            )}
          </div>
          <div>
            <div className="si-sec">Details</div>
            {inv.salesOrder?.number && <Row k="Sales Order" v={inv.salesOrder.number} />}
            {inv.customerPoNo && <Row k="Buyer's PO" v={`${inv.customerPoNo}${inv.customerPoDate ? ` dt. ${dateIn(inv.customerPoDate)}` : ''}`} />}
            <Row k="Supply Type" v={interState ? 'Inter-State (IGST)' : 'Intra-State (CGST + SGST)'} />
            {inv.vehicleNo && <Row k="Vehicle No" v={inv.vehicleNo} />}
            {inv.driverPhone && <Row k="Driver Phone" v={inv.driverPhone} />}
            {inv.transporter && <Row k="Transporter" v={inv.transporter} />}
          </div>
        </div>

        <div className="si-table-wrap">
          <table className="si-table">
            <thead>
              <tr>
                <th>#</th><th>Item</th><th>HSN</th><th className="n">Qty</th><th className="n">Rate</th><th className="n">Disc %</th>
                <th className="n">GST %</th>{inv.cess > 0 && <th className="n">Cess %</th>}<th className="n">Taxable</th>
              </tr>
            </thead>
            <tbody>
              {inv.items.map((it, i) => {
                const m = itemMap.get(it.itemId)
                return (
                  <tr key={it.id}>
                    <td>{i + 1}</td>
                    <td>{m?.name || it.itemId}{m?.code ? <span className="si-muted"> ({m.code})</span> : null}</td>
                    <td>{it.hsn || '—'}</td>
                    <td className="n">{it.qty}{m?.uom ? ` ${m.uom}` : ''}</td>
                    <td className="n">{money(it.rate)}</td>
                    <td className="n">{it.discountPct || 0}</td>
                    <td className="n">{it.gstRate}%</td>
                    {inv.cess > 0 && <td className="n">{it.cessRate || 0}%</td>}
                    <td className="n">{money(it.lineTotal)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div className="si-grid">
          <div>
            <div className="si-sec">Bank Details</div>
            {hasBank ? (
              <div className="si-box">
                <div>A/C Name: {bank.holder}</div>
                {bank.bankName && <div>Bank: {bank.bankName}{bank.branch ? `, ${bank.branch}` : ''}</div>}
                {bank.accountNo && <div>A/C No.: {bank.accountNo}</div>}
                {bank.ifsc && <div>IFSC: {bank.ifsc}</div>}
                {bank.upi && <div>UPI: {bank.upi}</div>}
                {upiLink && <a className="si-upi no-print" href={upiLink}>Pay {money(balance)} by UPI</a>}
                {upiQr && (
                  <div className="si-qr">
                    <img src={upiQr} alt="UPI payment QR code" width={130} height={130} />
                    <div className="si-strong">Scan to pay {money(balance)}</div>
                  </div>
                )}
              </div>
            ) : <div className="si-muted">As per records</div>}
            <div className="si-words">Amount in words: Rupees {amountInWords(inv.grandTotal)} Only</div>
          </div>
          <div>
            <Tot k="Subtotal" v={money(inv.subtotal)} />
            {inv.discountTotal > 0 && <Tot k="Discount" v={`- ${money(inv.discountTotal)}`} />}
            {inv.freightCharge > 0 && <Tot k={`Freight (GST ${inv.freightGstRate}%)`} v={money(inv.freightCharge)} />}
            {inv.packingCharge > 0 && <Tot k={`Packing (GST ${inv.packingGstRate}%)`} v={money(inv.packingCharge)} />}
            {interState
              ? <Tot k="IGST" v={money(inv.igst)} />
              : <><Tot k="CGST" v={money(inv.cgst)} /><Tot k="SGST" v={money(inv.sgst)} /></>}
            {inv.cess > 0 && <Tot k="Cess" v={money(inv.cess)} />}
            {Math.abs(inv.roundOff || 0) >= 0.005 && <Tot k="Round Off" v={`${inv.roundOff > 0 ? '+ ' : '- '}${money(Math.abs(inv.roundOff))}`} />}
            <div className="si-grand"><Tot k="Grand Total" v={money(inv.grandTotal)} /></div>
            {inv.paidAmount > 0 && <Tot k="Paid" v={money(inv.paidAmount)} />}
            {inv.paidAmount > 0 && <Tot k="Balance Due" v={money(balance)} />}
          </div>
        </div>

        {inv.notes && <div className="si-notes">Notes: {inv.notes}</div>}

        <div className="si-grid si-foot">
          <div>
            {company.invoiceTerms?.trim() && (
              <>
                <div className="si-sec">Terms &amp; Conditions</div>
                <div className="si-muted si-pre">{company.invoiceTerms.trim()}</div>
              </>
            )}
          </div>
          <div className="si-sign">
            <div className="si-strong">For {company.name}</div>
            {sign && <img className="si-signimg" src={sign} alt="" />}
            <div className="si-signline">Authorised Signatory</div>
          </div>
        </div>
        <div className="si-footer">This is a computer-generated GST tax invoice.</div>
      </div>
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return <div className="si-row"><span className="si-muted">{k}</span><span>{v}</span></div>
}
function Tot({ k, v }: { k: string; v: string }) {
  return <div className="si-row"><span>{k}</span><span className="si-num">{v}</span></div>
}

const CSS = `
  html, body { background: #f4f4f5 !important; color: #111 !important; }
  .si-page { min-height: 100vh; padding: 16px; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; font-size: 13px; color: #111; }
  .si-toolbar { max-width: 860px; margin: 0 auto 12px; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; color: #444; }
  .si-print-btn { background: #047857; color: #fff; border: 0; border-radius: 6px; padding: 8px 14px; font-weight: 600; cursor: pointer; }
  .si-print-btn:hover { background: #065f46; }
  .si-doc { max-width: 860px; margin: 0 auto; background: #fff; border: 1.5px solid #333; }
  .si-title { text-align: center; font-weight: 800; letter-spacing: 4px; font-size: 15px; padding: 8px; border-bottom: 1.5px solid #333; }
  .si-head { display: flex; justify-content: space-between; gap: 16px; padding: 12px; flex-wrap: wrap; border-bottom: 1px solid #444; }
  .si-seller { display: flex; gap: 12px; align-items: flex-start; }
  .si-logo { max-height: 64px; max-width: 150px; object-fit: contain; }
  .si-name { font-size: 17px; font-weight: 700; }
  .si-meta { text-align: right; }
  .si-muted { color: #555; font-size: 12px; line-height: 1.5; }
  .si-strong { font-weight: 700; font-size: 13px; }
  .si-break { word-break: break-all; max-width: 280px; }
  .si-pre { white-space: pre-wrap; }
  .si-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 10px 12px; border-bottom: 1px solid #444; }
  .si-sec { font-size: 9px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; color: #555; margin-bottom: 4px; }
  .si-row { display: flex; justify-content: space-between; gap: 12px; padding: 2px 0; }
  .si-num { font-variant-numeric: tabular-nums; }
  .si-grand { border-top: 1px solid #333; margin-top: 4px; padding-top: 4px; font-weight: 700; font-size: 15px; }
  .si-table-wrap { overflow-x: auto; }
  .si-table { width: 100%; border-collapse: collapse; }
  .si-table th, .si-table td { border-bottom: 1px solid #ccc; padding: 6px 8px; text-align: left; font-size: 12px; }
  .si-table th { background: #f4f4f5; font-weight: 600; border-bottom: 1px solid #444; }
  .si-table .n { text-align: right; white-space: nowrap; }
  .si-box { border: 1px solid #444; padding: 8px 10px; font-size: 12px; line-height: 1.7; }
  .si-qr { margin-top: 8px; text-align: center; width: 150px; }
  .si-qr img { display: block; margin: 0 auto; width: 130px; height: 130px; }
  .si-upi { display: inline-block; margin-top: 6px; color: #047857; font-weight: 600; }
  .si-words { font-weight: 700; margin-top: 8px; font-size: 12px; }
  .si-notes { padding: 6px 12px; border-bottom: 1px solid #444; color: #444; }
  .si-foot { border-bottom: 0; }
  .si-sign { text-align: right; }
  .si-signimg { max-height: 54px; max-width: 170px; object-fit: contain; display: block; margin: 8px 0 0 auto; }
  .si-signline { border-top: 1px solid #333; margin-top: 56px; padding-top: 4px; font-size: 11px; text-align: center; }
  .si-footer { border-top: 1.5px solid #333; padding: 6px; font-size: 10px; color: #444; text-align: center; }
  @media (max-width: 640px) {
    .si-grid { grid-template-columns: 1fr; }
    .si-meta { text-align: left; }
  }
  @media print {
    @page { size: A4; margin: 10mm; }
    html, body { background: #fff !important; }
    .si-page { padding: 0; }
    .si-toolbar, .no-print { display: none !important; }
    .si-doc { max-width: none; }
    .si-grid { grid-template-columns: 1fr 1fr; }
  }
`
