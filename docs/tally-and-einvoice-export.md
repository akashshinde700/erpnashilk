# Tally import files & GST e-Invoice JSON

Two file-based exports on **Sales → Sales Invoices**. Both are ported from the
Sheetaldies ERP (`akashshinde700/sheetaldies_erp`, invoice module) and need no
network path to Tally or to the GST portal — the file is downloaded and taken
there by the user.

Every invoice row has one **Tally / e-Invoice export** menu (the download icon in
the Actions column).

## Tally

| Item | What it does |
| --- | --- |
| **Tally XML (import file)** | `INV-26-27-0001_tally.xml` — a TallyPrime import envelope (`Import Data` / `Vouchers`) with the sales voucher: party ledger, sales ledger, CGST/SGST/IGST, freight, round-off and one inventory line per invoice line. |
| **Tally JSON** | the same voucher as plain data (`voucherType`, `voucherNumber`, `remoteId`, `date`, `party`, `items[]`, `entries[]`, totals) for a script or another accounting tool. |
| **Tally Excel** | the voucher as a check-sheet — one row per item and per ledger line, plus a summary sheet — for whoever verifies the entry before importing. |
| **Mark as sent to Tally** | records `tallySentAt` on the invoice (shown in the menu and audit log). Nothing is locked: Tally stays the book of record. |

Endpoints:

```
GET  /api/sales-invoices/:id/tally?format=xml|json|excel   → file download
GET  /api/sales-invoices/:id/tally?preview=1               → voucher + warnings (JSON envelope)
POST /api/sales-invoices/:id/tally   { action: "mark-sent" | "unmark" }
```

### Things Tally is strict about (and that the builder handles)

* **Ledger names must exist in the Tally company, spelled identically.** Tally never
  creates a master on import; it raises an exception instead. Order of precedence:
  company setting (`Settings` → Tally ledger names) → `TALLY_LEDGER_*` env vars →
  the standard defaults (`Sales`, `Central Tax on Sales @ 9%`, `State Tax on Sales @ 9%`,
  `Integrated Tax on Sales @ 18%`, `Transport & Freight Charges`, `Round Off`).
* **One voucher per import, keyed by `REMOTEID`** (`MANUFLOW-INV-<invoiceId>`).
  Without it, re-importing the same invoice creates a second voucher and the books
  double-count.
* **Invoice-mode vouchers read `LEDGERENTRIES.LIST`** (`ISINVOICE=Yes`); the
  double-entry `ALLLEDGERENTRIES.LIST` is silently ignored and surfaces as
  "No accounting or inventory entries are available".
* **The voucher must balance.** The party is debited with the grand total, so any
  residual (round-off, freight rounding) is booked to the Round Off ledger.
* **The importer is not a general XML parser**: an unescaped `&`/`<` aborts the parse
  and non-ASCII bytes (₹, smart quotes) get mangled. Everything is escaped and
  transliterated to ASCII.

If a name in the invoice does not exist in Tally the import shows up in Tally's
**Import Exceptions** report. The voucher preview (`?preview=1`) returns the same
warnings the UI shows before the download.

### Direct push

There is deliberately **no "push to a URL"** action: a request-supplied URL would
let any signed-in user make the server call an internal address (SSRF). Installs
where ManuFlow runs next to Tally use the connector setting `TALLY_HTTP_URL`
(see `docs/tally-connector.md`); everything else uses the XML file.

## GST e-Invoice (IRP / NIC)

**e-Invoice JSON (GST portal)** downloads the NIC *Invoice Bulk Upload* schema v1.1
for that invoice and opens <https://einvoice1.gst.gov.in/Invoice/BulkUpload> in a
new tab:

```json
[{
  "Version": "1.1",
  "TranDtls": { "TaxSch": "GST", "SupTyp": "B2B", "RegRev": "N", "IgstOnIntra": "N" },
  "DocDtls": { "Typ": "INV", "No": "INV/26-27/0001", "Dt": "03/09/2026" },
  "SellerDtls": { "Gstin": "…", "LglNm": "…", "Addr1": "…", "Loc": "…", "Pin": 411026, "Stcd": "27" },
  "BuyerDtls":  { "Gstin": "…", "LglNm": "…", "Pos": "27", … },
  "ItemList": [{ "SlNo": "1", "PrdDesc": "…", "IsServc": "N", "HsnCd": "84836090",
                 "Qty": 5, "Unit": "NOS", "UnitPrice": 5000, "AssAmt": 25000,
                 "GstRt": 18, "CgstAmt": 2250, "SgstAmt": 2250, "IgstAmt": 0, "TotItemVal": 29500 }],
  "ValDtls": { "AssVal": 25000, "CgstVal": 2250, "SgstVal": 2250, "IgstVal": 0,
               "OthChrg": 0, "RndOffAmt": 0, "TotInvVal": 29500 }
}]
```

```
GET /api/sales-invoices/:id/einvoice?check=1     → { ready, problems }   (no file)
GET /api/sales-invoices/:id/einvoice             → file + X-EInvoice-Warnings header
GET /api/sales-invoices/:id/einvoice?preview=1   → { json, problems }
```

`validateForIrp()` runs first so the portal's error report is not the first place a
mistake shows up. It checks:

* invoice number present, ≤ 16 characters, not starting with `0`, `/` or `-`
* seller **and** buyer GSTIN valid (e-invoicing is B2B only)
* 6-digit PIN for both parties (from the pincode field, else the last 6-digit run
  in the address) and a determinable state code
* every line has a 4–8 digit HSN/SAC and a quantity
* a proforma invoice or bill of supply is not reportable as a tax invoice

A download still succeeds when there are problems (the portal is the final
authority); the list rides along in `X-EInvoice-Warnings` and the UI shows it as a
warning toast.

After the portal generates the IRN, record it on the invoice — the existing
**Generate IRN** action (mock gateway) or the direct `irn` / `ewayBillNo` fields.
The Tally XML picks both up (`<IRNNO>`, `<EWAYBILLDETAILS.LIST>`).

## One-time setup: masters file + importer

Tally never creates a master while importing a voucher — a voucher that names a
ledger the company does not have comes back as *Ledger not found*. The old way was
to type every ledger by hand. Two downloads remove that step:

| Download | Where | What it does |
| --- | --- | --- |
| **Tally masters (XML)** | Sales Invoices → Tally menu, or Settings → Tally export | `GET /api/tally/masters?companyId=…` — an *All Masters* import that creates the sales / CGST / SGST / IGST / freight / round-off ledgers under the exact names this company's export uses (Settings overrides included), the units the item master uses, and one `Sundry Debtors` ledger per active customer (`?parties=0` skips the customers) |
| **Tally importer (.bat)** | same two places | `/downloads/tally/Tally-Import.bat` — posts a downloaded voucher file to Tally over HTTP and prints `CREATED / ALTERED / ERRORS / EXCEPTIONS` |

### Importing a voucher with the .bat

1. Download **Tally XML (import file)** for the invoice.
2. Drag that `*_tally.xml` onto `Tally-Import.bat` (or double-click it — it picks the
   newest `*_tally.xml` in `Downloads`).
3. The batch file POSTs the file to `http://127.0.0.1:9000` and prints Tally's counts;
   `<LINEERROR>` lines are echoed with a hint for the usual causes.

Tally has to be open with its HTTP server on: *F1 Help → Settings → Connectivity →
Client/Server configuration*, **TallyPrime acts as: Both**, port **9000**. Tally on
another machine? Put `TALLY_URL=http://192.168.1.20:9000` in
`Tally-Import.config.txt` next to the `.bat`.

Re-importing the same file updates the voucher instead of duplicating it — every
envelope carries `REMOTEID="MANUFLOW-INV-<id>"`.

## Configuration

| Setting | Where | Purpose |
| --- | --- | --- |
| `tallyCompanyName` | Company (Settings) | `SVCURRENTCOMPANY` in the import envelope — must match the open Tally company exactly |
| `tallySalesLedger`, `tallyCgstLedger`, `tallySgstLedger`, `tallyIgstLedger`, `tallyFreightLedger`, `tallyRoundOffLedger` | Company (Settings) | Ledger names for the export |
| `TALLY_LEDGER_SALES`, `TALLY_LEDGER_CGST`, `TALLY_LEDGER_SGST`, `TALLY_LEDGER_IGST`, `TALLY_LEDGER_FREIGHT`, `TALLY_LEDGER_ROUNDOFF`, `TALLY_LEDGER_CESS` | env | Fallback ledger names |
| `tallyLedgerName` | Customer / Supplier | Ledger name when Tally spells the party differently |
| `TALLY_HTTP_URL` | env | Only for the connectivity check / direct-import connector |

## Tests

* `e2e/specs/10-tally-einvoice.spec.ts` — the UI flow: all three Tally downloads,
  the sent-to-Tally mark, and the e-Invoice JSON download (content asserted).
* `e2e/unit/tally-export.spec.ts` — the builders themselves: voucher balances, the
  Round Off residual, XML escaping/invoice-mode entries, ledger-name precedence,
  IRP validation, the intra-state / inter-state tax split, and the masters file
  (ledger groups, unit de-duplication, party overrides).
