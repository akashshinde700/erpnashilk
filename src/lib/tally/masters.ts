import { tallyText, type TallyLedgerNames } from './voucher'

/**
 * Tally masters file — the ledgers and units the import needs to already exist.
 *
 * Tally never creates a master while importing a voucher: a voucher that names a
 * ledger the company does not have is rejected with "Ledger not found", and the
 * user is left to type every ledger in by hand. This builds an "All Masters"
 * import that creates exactly the names ManuFlow writes into the voucher (so the
 * Settings → Tally export overrides are respected), plus one ledger per customer
 * so the party actually exists.
 *
 * Ships next to `Tally-Import.bat`: download it, import it once into the Tally
 * company, then voucher imports stop failing on missing masters.
 */

export interface MastersInput {
  companyName?: string | null
  /** Ledger names as resolved for the voucher export (company setting → env → default). */
  ledgers: TallyLedgerNames
  /** Units used by invoices (from the item master), e.g. NOS, KGS. */
  units?: string[]
  /** Party ledgers to create, e.g. `{ name: 'Precision Tools Pvt Ltd', gstin: '27…' }`. */
  parties?: { name: string; gstin?: string | null; tallyLedgerName?: string | null }[]
}

const TAX_LEDGERS = new Set(['cgst', 'sgst', 'igst', 'cess'] as const)

const unitXml = (unit: string) => `        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <UNIT NAME="${tallyText(unit)}" ACTION="Create">
            <NAME>${tallyText(unit)}</NAME>
            <ISSIMPLEUNIT>Yes</ISSIMPLEUNIT>
            <DECIMALPLACES>3</DECIMALPLACES>
          </UNIT>
        </TALLYMESSAGE>`

const ledgerXml = (name: string, parent: string, isTax = false) => `        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <LEDGER NAME="${tallyText(name)}" ACTION="Create">
            <NAME>${tallyText(name)}</NAME>
            <PARENT>${tallyText(parent)}</PARENT>${isTax ? `
            <TAXTYPE>Others</TAXTYPE>` : ''}
            <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
            <OPENINGBALANCE>0</OPENINGBALANCE>
          </LEDGER>
        </TALLYMESSAGE>`

/** Parent group per ledger role — Tally needs a valid group or it refuses the ledger. */
const PARENT: Record<keyof TallyLedgerNames, string> = {
  sales: 'Sales Accounts',
  cgst: 'Duties & Taxes',
  sgst: 'Duties & Taxes',
  igst: 'Duties & Taxes',
  cess: 'Duties & Taxes',
  freight: 'Indirect Incomes',
  roundOff: 'Indirect Expenses',
}

export function buildMastersXml(input: MastersInput, tallyCompanyName?: string | null): string {
  // A role can point at the same ledger (two taxes on one head) — create it once.
  const ledgers = (Object.keys(PARENT) as (keyof TallyLedgerNames)[])
    .map((role) => ({ name: (input.ledgers[role] || '').trim(), parent: PARENT[role], isTax: TAX_LEDGERS.has(role as 'cgst') }))
    .filter((l) => l.name)
    .filter((l, i, all) => all.findIndex((x) => x.name.toLowerCase() === l.name.toLowerCase()) === i)

  const units = Array.from(
    new Set((input.units || []).map((u) => (u || '').trim()).filter(Boolean).map((u) => u.toUpperCase())),
  )
  if (!units.length) units.push('NOS')

  const parties = (input.parties || [])
    .map((p) => ({ name: ((p.tallyLedgerName || '').trim() || (p.name || '').trim()), gstin: p.gstin }))
    .filter((p) => p.name)
    .filter((p, i, all) => all.findIndex((x) => x.name.toLowerCase() === p.name.toLowerCase()) === i)

  const companyBlock = tallyCompanyName
    ? `
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${tallyText(tallyCompanyName)}</SVCURRENTCOMPANY>
        </STATICVARIABLES>`
    : ''

  const body = [
    ...units.map(unitXml),
    ...ledgers.map((l) => ledgerXml(l.name, l.parent, l.isTax)),
    ...parties.map((p) => ledgerXml(p.name, 'Sundry Debtors')),
  ].join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>All Masters</REPORTNAME>${companyBlock}
      </REQUESTDESC>
      <REQUESTDATA>
${body}
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`
}

export function mastersFileName(companyName?: string | null): string {
  const slug = (companyName || 'company').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return `tally-masters-${slug || 'company'}.xml`
}

/** Static importer that posts a downloaded voucher to Tally over HTTP. */
export const TALLY_IMPORT_BAT_PATH = '/downloads/tally/Tally-Import.bat'
