# Vyapar backup import (Import Center → Vyapar → Upload a Vyapar backup)

What a Vyapar customer's data actually looks like, and what ManuFlow reads from it.

## The file

| | |
|---|---|
| `.vyb` | The backup Vyapar writes (Settings → Backup & Restore). A ZIP; inside it there is one `.vyp` file per Vyapar company. |
| `.vyp` | That company's SQLite database (starts with `SQLite format 3`). It can be uploaded on its own. |

Both are accepted. With several `.vyp` files in one ZIP, the largest is read (the normal case is one
company; the summary shows which file was used).

Read on the server, in memory, nothing written to disk: `src/lib/vyapar/zip.ts` (ZIP under a hard
inflate budget), `src/lib/vyapar/sqlite.ts` (a read-only SQLite reader — no native module, so it
behaves the same under Bun in production and Node in development), `src/lib/vyapar/backup.ts`
(Vyapar's tables → one snapshot), `src/lib/vyapar/to-import.ts` (snapshot → Import Center tables),
`src/app/api/import-center/vyapar/*` (inspect / import), `src/components/erp/import-center/vyapar-backup.tsx` (the flow).

## Vyapar's own tables

| Table | What ManuFlow takes from it |
|---|---|
| `kb_firms` | Company name, GSTIN, state, address, phone, email, bank — shown so the user confirms the right company |
| `kb_names` | Parties: `name_type` 1 = customer, 2 = supplier. Name, phone, email, GSTIN, state, address, pincode |
| `kb_items` | Items: name, code, HSN (`item_hsn_sac_code`), GST rate (through `item_tax_id` → `kb_tax_code`), unit (`base_unit_id` → `kb_item_units`), sale / purchase price, MRP, category, current stock quantity and value |
| `kb_transactions` | Vouchers — counted only: 1 sale, 2 purchase, 3 payment in, 4 payment out, 5/6 party opening balances, 7 expense |
| `kb_paymentTypes` | Cash / bank accounts with their opening balance (shown, not imported) |

Nothing is executed and no SQL is run: the reader parses the file format (header, `sqlite_master`,
b-tree pages, overflow chains, records). A table that does not exist is reported, never guessed, so a
backup from another Vyapar version still works as long as `kb_firms`, `kb_names` and `kb_items` are there.

## The sample this was built on

A real customer backup (a `.vyb` holding one `.vyp`, financial year 2026-27). It is client data and is **not in
Git**: keep a copy outside the repository (or in the gitignored `data/` folder) and the backup tests use it — see
`tests/vyapar-backup.test.ts`. The reader was checked against it field by field: the company (name, GSTIN, state,
address), customers and suppliers with and without a GSTIN, a few thousand items (services included; some without a
GST rate, a unit or an HSN), stock on hand with Vyapar's own value, vouchers of every type, and cash / bank opening
balances. The customer's own figures are deliberately not recorded here.

Units seen in it: NUMBERS, KILOGRAMS, METERS, PIECES, EA, PACKS, SET, PAIRS, ROLLS, LITRE, FOOT, BOX, UNIT,
SQUARE METERS, SQUARE FEET, BAGS — and items with no unit at all.

## What is imported

Only what the Import Center already supports end to end — the same services, duplicate rules and
Import History as a file import:

| Data type | From | Rules |
|---|---|---|
| Customers | `kb_names` name_type 1 | Name, GSTIN, GST type (Regular when a GSTIN exists, else Unregistered), phone, email, address, state, pincode. Codes are generated (C-0001…). Duplicates (same name / code) are skipped |
| Suppliers | `kb_names` name_type 2 | Same fields, S-0001 codes |
| Items | `kb_items` | Name, code, HSN, GST rate, unit, purchase / sale price, MRP, category. Vyapar services (item_type 2) become `SERVICE` items, everything else gets the type the user picks |
| Opening stock | `kb_items` stock | Item name, quantity, rate = Vyapar stock value ÷ quantity, value — posted at the company's go-live date into the warehouse the user chooses, tagged `OSI-…` for the reconciliation |

Two gaps in Vyapar data have to be filled by the user before an item import (the flow asks, and the
choice is written to the Import History):

- **Items with no GST rate** in Vyapar → choose the rate to use (0 / 5 / 12 / 18 / 28 %).
- **Units ManuFlow does not have** → choose the unit to use (PACKS, PAIRS, FOOT, BAGS and "no unit" in
  the sample). ManuFlow's units are NOS, PCS, KG, GM, LTR, MTR, MTR2, BOX, SET, ROLL, HRS; Vyapar has
  31. Units that do match (NUMBERS → NOS, KILOGRAMS → KG, METERS → MTR, SQUARE METERS → MTR2 …) are
  mapped automatically by `VYAPAR_UNITS` in `src/lib/vyapar/shared.ts`.

Inactive parties / items are skipped (the import has no "inactive" column) and counted.

## Not imported (yet)

- **Vouchers**: sales, purchases, receipts, payments, expenses, credit / debit notes. The flow shows
  their counts and date range so the summary matches Vyapar, and says plainly that they are not imported.
- **Party balances** (`kb_names.amount`) and **cash / bank opening balances** (`kb_paymentTypes`):
  they need the go-live date and their own accounting treatment — see `docs/opening-balances.md`.
- **Credit limit, secondary units, batches / serials, item images, attachments.**

## Batch size and flow

1. Upload → `POST /api/import-center/vyapar/inspect` (multipart). Returns the summary; the snapshot
   stays in server memory for 30 minutes (`src/lib/vyapar/store.ts`). Upload cap 256 MB.
2. Choose the data types, item type, GST / unit fallbacks, warehouse and go-live date.
3. `POST /api/import-center/vyapar/import` with `mode: preview` — read-only dry run, batch by batch
   (≤ 500 records per batch, `VYAPAR_BATCH_ROWS`).
4. `mode: commit` + `confirm: true` — the same batches through the real import services; one Import
   History entry per batch. Opening stock also needs `options.goLiveDate` equal to the company's
   go-live date and a date that is not in the future (same rule as a file import).

Permissions: Import Center write access, plus write access to the target module (customers, suppliers,
items, stock), company from the session (another company's id → 403).

## End-user guide (Hinglish, with screen visuals)

`docs/ManuFlow-Vyapar-Import-Guide-Hinglish.docx` — beginner guide for the whole import flow
(menus, upload, choices, preview, post-import checks, common messages). Rebuild it with
`docs/manual/gen_vyapar.py` + `docs/manual/build_vyapar_docx.py`; see `docs/manual/README.md`.

## Tests

`tests/vyapar-backup.test.ts` — reads the real backup in `data/` (SQLite reader, ids, snapshot totals,
.ZIP path, batch tables, unit mapping) without touching the database.
