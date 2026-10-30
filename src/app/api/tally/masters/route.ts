import { db } from '@/lib/db'
import { companyRequired, handleError, ApiError, requireRead } from '@/lib/erp-helpers'
import { ledgerNames } from '@/lib/tally/voucher'
import { buildMastersXml, mastersFileName } from '@/lib/tally/masters'

/**
 * GET /api/tally/masters?companyId=&parties=0
 *
 * All-Masters import for TallyPrime: the sales / CGST / SGST / IGST / freight /
 * round-off ledgers under the names this company's voucher export uses, the units
 * the item master uses, and one ledger per customer (parent "Sundry Debtors").
 *
 * Tally rejects a voucher naming a ledger it does not have ("Ledger not found"),
 * so this is the one-time file that makes the invoice imports work. Optional
 * `?parties=0` skips the customer ledgers when the chart of accounts already has
 * them.
 */
export async function GET(req: Request) {
  try {
    requireRead(req, ['sales-invoices', 'receivables', 'gst-report'])
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const withParties = searchParams.get('parties') !== '0'

    const company = await db.company.findUnique({
      where: { id: companyId },
      select: {
        name: true,
        tallyCompanyName: true, tallySalesLedger: true, tallyCgstLedger: true, tallySgstLedger: true,
        tallyIgstLedger: true, tallyFreightLedger: true, tallyRoundOffLedger: true,
      },
    })
    if (!company) throw new ApiError('Company not found', 404)

    const [items, customers] = await Promise.all([
      db.item.findMany({ where: { companyId }, select: { uom: true } }),
      withParties
        ? db.customer.findMany({
          where: { companyId, status: 'ACTIVE' },
          select: { name: true, gstin: true, tallyLedgerName: true },
          orderBy: { name: 'asc' },
        })
        : Promise.resolve([]),
    ])

    type ItemRow = { uom: string }
    type CustomerRow = { name: string; gstin: string | null; tallyLedgerName: string | null }

    const xml = buildMastersXml(
      {
        companyName: company.name,
        ledgers: ledgerNames(company as any),
        units: (items as ItemRow[]).map((i) => i.uom),
        parties: (customers as CustomerRow[]).map((c) => ({ name: c.name, gstin: c.gstin, tallyLedgerName: c.tallyLedgerName })),
      },
      company.tallyCompanyName,
    )

    return new Response(xml, {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Disposition': `attachment; filename="${mastersFileName(company.name)}"`,
      },
    })
  } catch (e) {
    return handleError(e)
  }
}
