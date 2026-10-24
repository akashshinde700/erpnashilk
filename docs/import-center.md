# Import Center (Utilities → Import Center)

Module key `import-center`, sidebar group **Utilities** (between Finance and Admin). Visible to
Tenant Admin, Management and Super Admin only. The app has no URL routing — like every module it is
opened from the sidebar, the command palette (Ctrl/⌘ K), favourites and recents.

Two methods: **Direct Import from Tally** (connection diagnostics only — see `docs/tally-connector.md`)
and **File Upload**:

| Data type | Status |
|---|---|
| Customers, Suppliers, Items | Import end to end |
| Opening stock | Import end to end — needs the go-live date; reconciled (see `docs/opening-balances.md`) |
| Opening balances (customers / suppliers) | **Check and reconcile only** — not importable until the accounting model in `docs/opening-balances.md` exists |
| Sales / purchase invoices, receipts, payments | Listed as planned, not available |

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
| Accepted | `.xlsx` (Excel 2007+), `.csv` / `.tsv` / `.txt` (comma, semicolon or tab; UTF-8, UTF-8 BOM, UTF-16 "Unicode text", Windows-1252) |
| Refused | `.xls` (Excel 97-2003 — save as .xlsx), `.xlsb`, `.ods`, password-protected workbooks, Vyapar backups (`.vyb`), anything else |
| File size | 2 MB (checked on Content-Length before reading, and again on the file) |
| Rows | 500 data rows per import (+ up to 15 title rows) |
| Columns / cells | 60 columns, 1 000 characters per cell |
| XLSX safety | every ZIP entry is inflated with a hard cap (40 MB total, 2 000 parts) **before** SheetJS sees the file — catches zip bombs, including ones that lie about sizes; formulas are never evaluated (only the saved value is read) |

The format is decided by the file's bytes, not its name.

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
purchase invoices, receipts / payments, Tally direct import, Vyapar backup files.
