# Import Center (Utilities → Import Center)

Module key `import-center`, sidebar group **Utilities** (between Finance and Admin). Visible to
Tenant Admin, Management and Super Admin only. The app has no URL routing — like every module it is
opened from the sidebar, the command palette (Ctrl/⌘ K), favourites and recents.

Three routes in:

- **Direct Import from Tally** — the ManuFlow Tally Connector (see `docs/tally-connector.md`).
- **Vyapar backup (.vyb / .vyp)** — reads the backup Vyapar itself writes; nothing has to be exported
  by hand. See `docs/vyapar-backup.md`. The flow is the same pipeline as a file import (preview, then
  commit), batch by batch.
- **File Upload** — Excel (.xlsx), CSV / TSV, text in columns (.txt), XML (Tally XML too) and JSON for everything else.

| Data type | Status |
|---|---|
| Customers, Suppliers, Items | Import end to end (file, Tally connector, Vyapar backup) |
| Opening stock | Import end to end — needs the go-live date; reconciled (see `docs/opening-balances.md`) |
| Opening balances (customers / suppliers) | **Check and reconcile only** — not importable until the accounting model in `docs/opening-balances.md` exists |
| Tally vouchers (from a Tally XML file) | **Check only** — read with their full structure and checked (balance, cancelled, optional, lines); never imported into ManuFlow's books |
| Sales / purchase invoices, receipts, payments | Listed as planned, not available (the Vyapar backup flow counts them and says so) |

## File upload flow

1. Source (Tally / Vyapar / Excel-CSV — used for guidance and history only) and data type.
2. Upload: `POST /api/import-center/parse` (multipart). Parsed in memory on the server and returned
   to the browser; **the file is not stored**.
3. Header row: detected among the first 15 rows (Tally / Vyapar reports have title rows); changeable.
4. Column mapping: suggested by exact (normalised) alias match only — the user must tick
   "I have checked the mapping".
5. Preview: `POST /api/import-center/preview` runs the full validation and duplicate checks with the
   same services as the import, `dryRun` — **no writes, no audit entry**.
6. Confirm dialog with a second explicit tick.
7. Import: `POST /api/import-center/commit` with `confirm: true` — everything is re-validated on the
   server; valid rows are saved one transaction per row.
8. Result: imported / skipped (duplicates) / failed, per-row messages, downloadable problem-row CSV.
9. History tab: `GET /api/import-center/history`.

Code: `src/lib/import/` (fields + aliases, CSV, file parsing, mapping, pipeline),
`src/lib/services/customer-import.ts` and `item-import.ts` (shared with the old CSV dialogs on the
Customers / Items screens), `src/app/api/import-center/*`, `src/components/erp/import-center/*`.

## Formats and limits

| | |
|---|---|
| Accepted | `.xlsx` (Excel 2007+); `.csv` / `.tsv` (comma, semicolon or tab); `.txt` in columns (tab, `|`, `;` or comma — free text is refused); `.xml` (generic, and Tally XML); `.json`. Text: UTF-8, UTF-8 BOM, UTF-16 LE / BE ("Unicode text", Tally XML), Windows-1252; Marathi / Devanagari kept exactly |
| Refused | `.pdf` (rows and columns of a PDF cannot be read back reliably — business data is never guessed; export to Excel, CSV or XML instead), `.xls` (Excel 97-2003 — save as .xlsx), `.xlsb`, `.ods`, password-protected workbooks, anything else |
| Vyapar backups | `.vyb` / `.vyp` are **not** uploaded into the file flow — the Vyapar card reads them (own 256 MB limit, `docs/vyapar-backup.md`); uploading one here explains exactly that |
| File size | `.xlsx` / `.csv` / `.txt`: 2 MB. `.xml` / `.json`: 32 MB once unpacked. One upload request: 9 MB (below the 10 MB the Next.js proxy passes on) — the browser sends XML / JSON gzip-compressed, the server unpacks it with a hard 32 MB cap (a compressed "bomb" is refused) |
| Rows | 500 data rows per import (+ up to 15 title rows). XML / JSON customers, suppliers and items: up to 5 000 records per file, checked and imported by the browser in parts of 500 (each part is one preview / commit and one history entry). Duplicates are found across the **whole file**: after the parts are previewed, a ready row that repeats an earlier ready row (same rules as the import services — customers / suppliers by name or explicit code, items by code, the item form's name rule or barcode) is shown as a duplicate ("Same name … as row 4 earlier in this file") and is **not sent** to the import; the server's database duplicate checks still apply to everything that is sent |
| Large uploads | At most 2 large uploads (≥ 1 MB on the wire, or any compressed upload) are read at once per server process; another one gets 429 "try again in a minute" instead of piling up memory. Measured: a 30 MB Tally XML (6 131 stock items) parses in ~1.6 s with ~330 MB extra RSS; nothing is retained afterwards |
| Columns / cells | 60 columns, 1 000 characters per cell |
| XLSX safety | every ZIP entry is inflated with a hard cap (40 MB total, 2 000 parts) **before** SheetJS sees the file — catches zip bombs, including ones that lie about sizes; formulas are never evaluated (only the saved value is read) |

The format is decided by the file's bytes, not its name: ZIP → .xlsx only; `%PDF` → refused; text starting with `<` → XML,
`{` / `[` → JSON, otherwise delimited text. A name that contradicts the content (e.g. XML saved as `.csv`) is refused.

### XML and JSON (`src/lib/import/structured.ts`)

Records are found, not assumed: the repeated elements (or the objects of a list) that carry fields. A file with several
kinds of record (e.g. `<customers>` and `<items>`, or `{"customers": [...], "items": [...]}`) offers each like a
workbook sheet. Attributes and simple nested fields become columns (`address.city`); a repeated simple field is joined
with `; `. A repeated nested group inside a record (e.g. `<orders><order>…`) is **not** flattened — it is left out and
the user is told, because flattening would lose which value belongs to which line. Field names become the header
row; mapping, preview, duplicates and import are the normal pipeline.

### Tally XML (`src/lib/import/tally-xml.ts`, separate from generic XML)

Layouts: `ENVELOPE/BODY/IMPORTDATA/REQUESTDATA/TALLYMESSAGE/<object>` (TallyPrime's export of masters / vouchers),
`BODY/DATA/TALLYMESSAGE` (report exports such as the Day Book) and `BODY/DATA/COLLECTION`. Built-in names lose
their `&#4;` marker. An `ACTION="Create"` / `"Cancel"` attribute is reported, never carried out.

| Tally objects | Offered as |
|---|---|
| LEDGER: GSTIN and registration type | Both from one source: the latest dated GST registration (LEDGSTREGDETAILS.LIST) when the ledger has one, else the ledger's own fields. Conflicts — two different registrations from the same date, the ledger's GSTIN differing from its latest registration, a GSTIN with type Unregistered / Consumer, a registered type without GSTIN — are never resolved by guessing: both values are left blank and the row gets an **Import check** message, which makes it an error in the preview |
| LEDGER under Sundry Debtors (sub-groups followed through the file's GROUP objects) | Customers — and Opening balances (check only): opening balance shown as "1,500.50 Dr" (Tally's minus = debit) |
| LEDGER under Sundry Creditors | Suppliers (and opening balances) |
| STOCKITEM | Items: unit, HSN and IGST rate from the **latest** GST details (blank when Tally has none — never guessed), stock group (Tally's root group "Primary" = none) |
| STOCKITEM opening batch / godown allocations | Opening stock (go-live date needed as for any opening stock); values shown positive; batch number only for batch-wise items |
| VOUCHER | **Tally vouchers (check only)**: header, ledger lines with bill allocations, inventory lines with batch / godown and accounting allocations — normalised with the connector's Layer 1 rules (`src/lib/tally/vouchers.ts`); counts per type, period, cancelled, optional, not balanced, and the first 200 vouchers in full. Nothing is imported |

**Import check column:** a column headed exactly "Import check" (any file) carries a problem the file reader found; a
non-empty cell makes that row an error in `applyMapping` on the server, whatever the mapping — it can only block a row.

**Browser test:** `e2e/specs/14-file-import.spec.ts` runs the whole XML workflow in Chromium (upload compressed →
parse → data type → mapping → preview in two parts with a duplicate across parts and a GST conflict → confirm →
import) against stored responses in `e2e/fixtures/tally-masters.api.json`. `tests/import-e2e-contract.test.ts`
checks that those stored responses are exactly what the real routes return for the same made-up file; after an
intended API change regenerate them with `UPDATE_E2E_FIXTURES=1 bun test tests/import-e2e-contract.test.ts`.

Checked on a real TallyPrime master.xml (959 stock items, 101 parties) and voucher.xml (633 vouchers: 5 purchases
off by ₹0.10 are reported as not balanced). Those files are client data and are not in Git; the tests use made-up
files of the same structure (`tests/import-formats.test.ts`).

## Fields

**Customers** — name\* (Customer Name, Party Name, Ledger Name, Name), code, GSTIN (GSTIN, GST No,
GST Number, GSTIN/UIN), GST type, PAN, contact person, phone (Phone, Mobile, Contact Number),
email, address, city, state, GST state code, pincode, party type (CUSTOMER / BOTH).
Validation is the customer form's (`partyData`): GSTIN format, PAN / state code / GST type derived from
the GSTIN, 10-digit phone, email, pincode. A state name is turned into its GST state code when there is
no GSTIN; when both disagree the GSTIN wins and a warning is shown. Duplicates (same name, existing or
earlier in the file; same code) are skipped. Blank codes get the next `C-0001` code.

**Items** — name\* (Item Name, Product Name, Stock Item), code (Item Code, SKU), HSN/SAC (HSN, HSN Code,
HSN/SAC), GST rate %\* (GST Rate, Tax Rate, GST %), unit\* (Unit, UOM), purchase price, sale price
(Sale Price, Selling Price), MRP, category (Category, Stock Group), barcode, brand, item type.
Nothing is assumed: a blank GST rate or unit is a row error; units are matched only to ManuFlow's units
through unambiguous synonyms (Nos, Pcs, Kgs, Ltr, Mtr, Box, Set, Roll, Hrs…); "18%", "₹ 1,250.50"
and "1,400" are understood; a blank price is saved as 0 **with a warning**; the item type is chosen by
the user when no type column is mapped; blank codes get the next code of the type's series (warning).
Duplicates by code, barcode or same name (ignoring case / spaces / punctuation) are skipped.

**Suppliers** — name\* (Supplier Name, Vendor Name, Party Name, Ledger Name), code, GSTIN, GST type, PAN,
contact person, phone, email, address, city, state, GST state code, pincode, credit days (Credit Days,
Credit Period), bank name, account number (Account No, A/c No), IFSC, bank branch. Same party validation as the
supplier form (GSTIN / PAN / IFSC / account number / phone / pincode). Blank codes get the next `S-0001` code.
Skipped as duplicates: an existing supplier with the same name — including the supplier half of a "Both" party
(the message names the linked customer) — the same name earlier in the file, the same code. Created with a
warning: a customer-only party with the same name (link them as "Both" from Parties — not done automatically,
because linking makes the customer share the supplier's profile), a GSTIN already on another supplier
(branches share a GSTIN).

**Opening stock** — item code / item name (Particulars), warehouse (Godown), quantity\* ("100.00 Kgs"),
rate ("120.00/Kgs") and / or value, unit, batch, expiry. Details and rules: `docs/opening-balances.md`.

**Opening balances (check only)** — party name\*, code, GSTIN, balance ("12,500.00 Dr") with an optional Dr / Cr
column, or Debit / Credit (Receivable / Payable) columns.

**Not imported (by design in this phase)** — opening / closing balances, credit limits, opening
stock / quantities / values. Such columns are recognised and listed as "not imported" with the reason.
Opening balances need a go-live date and their own accounting treatment (writing them into
`openingBalance` fields is not enough); opening stock needs a verified go-live date, warehouse mapping
and valuation (today's stock posting would date it "now" and distort P&L).

## Security

- Every endpoint: signed session (middleware), `requireWrite('import-center')` **and** write access to
  the target module (customers / items), company from `companyRequired` (home company or linked firm;
  another company's id → 403). Cross-site POSTs are blocked by middleware.
- Mapping and table from the browser are re-validated on every preview / commit: catalogue fields only
  (no arbitrary keys, `__proto__` rejected), columns must exist, one column per field, required fields
  mapped, header row within the first 15 rows, row / column / cell / total-size caps.
- XML: a `DOCTYPE` or `ENTITY` declaration is refused outright (no XXE, no entity expansion); only the five standard
  entities and numeric character references are decoded; depth ≤ 64, ≤ 2 million elements, ≤ 64 attributes per
  element; the reader is a loop (no recursion). JSON: nesting ≤ 20 levels, counted before parsing.
- Uploads are read in memory only — never written to disk, so there are no temporary files to clean up — and nothing
  in a file is ever executed. File names are only shown as text (control characters stripped, 120 characters).
- Cells starting with `=` or `@` in mapped fields are row errors (spreadsheet formula injection); the
  downloadable problem-row CSV neutralises formula-like cells.
- Row errors shown to users are ManuFlow's own validation messages; database / internal errors are
  logged on the server and reported as "Failed to create customer / item".
- One import per company + data type at a time **in one server process** (`withImportLock`). With
  several app processes (PM2 cluster) two simultaneous imports of the same names could both pass the
  duplicate check — names are not unique in the database. A database-level lock is needed before
  running clustered.

## Go-live date

Opening figures need the company's go-live (cutover) date — set it in the Import Center when choosing an
opening data type (administrators; locked after opening stock is imported). See `docs/opening-balances.md`.

## History

One `AuditLog` row per committed import (`action: IMPORT`, entity `CUSTOMER` / `SUPPLIER` / `ITEM` /
`OPENING_STOCK`): a summary line, for opening stock the import reference with source vs posted totals
(`entityId` = the reference), and up to 25 row problems. No new tables (the production schema is applied with `prisma db push` on
deploy and has no migration history, so this phase avoids schema changes). Preview runs are not
recorded. The older CSV dialogs on the Customers / Items screens write their summary to the same place.

## Undo

Imports cannot be undone automatically. Masters can be deleted from their screens while unused; opening stock
is corrected with a stock adjustment (its ledger rows are immutable) — the import reference and the
reconciliation identify every posted row.

## Not done yet

Party opening balances (model missing — `docs/opening-balances.md`), cash / bank opening balances, sales /
purchase invoices, receipts / payments, importing Tally vouchers (they can be checked from a Tally XML file), PDF
import, Vyapar XML. Tally units that ManuFlow does not know (e.g. custom compound units) are row errors, not mapped.
The Vyapar backup flow (parties, items, opening stock) is done — `docs/vyapar-backup.md`.
