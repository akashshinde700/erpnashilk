# Opening figures: go-live date, opening stock, party opening balances

Status (Phase 2):

| | |
|---|---|
| Go-live (cutover) date | **Implemented** — `Company.goLiveDate`, Import Center → Go-live date |
| Opening stock import | **Implemented** — posted through the stock service, reconciled, duplicate-protected |
| Customer / supplier opening balances | **Check and reconcile only** — cannot be imported until the model below exists |

## Go-live date

- One date per company (`Company.goLiveDate`, nullable column added by `prisma db push` — additive, no data
  loss). Stored at UTC midnight of the day, the convention the reports use for a `from` date.
- Opening figures are dated at **noon UTC of the day before** (`openingDateFor` in `src/lib/go-live.ts`):
  before the go-live day's UTC midnight, so a report for a period that starts on the go-live date counts them
  as opening values — never as movements of the period (no "purchases", no profit; tested: P&L from go-live
  shows the imported stock as opening stock, purchases 0, COGS 0); before the previous day's local end of day
  (`endOfDayStr` — 18:29:59Z under the server's `TZ=Asia/Kolkata`), so an "as at <previous day>" report
  includes them; and displayed as the previous calendar day in India (17:30 IST) and in UTC.
- Set by Tenant Admin / Management / Super Admin (`PUT /api/import-center/go-live`, audit-logged).
- **Locked** once opening stock has been imported against it (409 on change).
- An import must echo the date the user confirmed (`options.goLiveDate`); a go-live date in the future can
  be previewed against but not imported against.

## Opening stock

`src/lib/services/opening-stock-import.ts`, data type `opening-stock` (module permission: stock adjustments).

- Posts through `postOpeningStock` → `postStock`: immutable `StockLedger` row (`type OPENING`,
  `refType OPENING`) **and** `StockBalance` at moving average in one transaction per row; batch layer for
  batch-tracked items. `StockBalance` is never written on its own.
- Every row of one import carries `refNumber = OSI-<timestamp>-<random>` (the reconciliation key) and the
  go-live opening timestamp as its date.
- Nothing is assumed: item must exist (code, or a name matching exactly one item); warehouse from a column
  (code or name of this company's warehouse) or an explicitly chosen default; quantity > 0 (zero → skipped,
  negative → error); rate or value required, and when both are given value must equal qty × rate (±0.1 %,
  min ₹0.50); the quantity's unit must be the item's unit (no conversion); batch-tracked items need a batch
  number (expiry optional); service and serial-tracked items are refused (serial numbers are not imported).
- Duplicate protection: any existing `OPENING` entry for the item + warehouse (item form or earlier import)
  → skipped; the same item + warehouse (+ batch) twice in a file → error; re-checked inside each row's
  transaction; one import per company + data type at a time per server process.
- Ordering: other stock movements for the item + warehouse dated **before** go-live → error (opening must be
  first — use a stock adjustment); movements **after** go-live → warning (allowed; the moving-average rate
  can differ slightly from a strictly chronological calculation).
- Reconciliation: the commit result compares file vs posted quantity and value per item + warehouse and in
  total (posted side read back from the ledger by the reference); the history entry stores the reference
  and both totals; `GET /api/import-center/opening-stock/reconcile?ref=` re-reads the posted side any time.
- **No rollback.** Ledger rows are immutable by design; correct mistakes with a stock adjustment. The
  reference identifies every row of an import.
- Not covered: alternate-unit quantities, serial numbers, manufacturing / expiry dates other than a batch's
  expiry, valuation methods other than ManuFlow's moving average.
- The item form's "opening stock" is unchanged (dated now). With a go-live date set, prefer the import for
  go-live stock and treat later receipts as purchases / GRNs.

## Party opening balances — why they are not imported yet

What exists today:

- `Customer.openingBalance` / `Supplier.openingBalance`: **one undated number** per party, editable on the
  party form. Receivables / payables (`partyOutstanding`), the party 360 view, statements and the balance
  sheet add it to invoice outstanding and treat it as "before everything".
- **It cannot be settled.** `POST /api/payments` requires an invoice (`invoiceId is required`). The Payments
  screen offers "— Advance / on account —", but the server rejects it (existing bug). So a receipt against
  an opening receivable cannot be recorded; the outstanding would stay until someone edits the party.
- Outstanding is computed inconsistently for unallocated money: `partyOutstanding` and the party view use
  invoice `paidAmount`; statements subtract all payments.

Writing imported balances into `openingBalance` would therefore create receivables / payables that the
books can never clear — and editing the field to "clear" them would bypass cash & bank. That is the unsafe
shortcut the requirements rule out.

What is implemented instead (data type `opening-balances`, preview only — the commit endpoint refuses it):

- Reads Tally / Vyapar debtor or creditor reports: `12,500.00 Dr`, `Cr 400`, `(1,200)`, a Dr / Cr column,
  or separate Debit / Credit (Receivable / Payable) columns. Plain amounts are a row error unless the user
  explicitly says how to read them.
- Matches each row to an existing customer or supplier (code, else exact name, else a unique GSTIN match —
  flagged), converts to ManuFlow's sign (customer Dr = receivable +, supplier Cr = payable +).
- Flags parties that already carry an opening balance (would double count), duplicate rows, unknown parties,
  and parties with invoices / payments dated before the go-live date.
- Totals Dr / Cr / net of the matched rows to compare with the source report's totals.

### Model needed before opening balances can be imported

1. `OpeningBalance` entries: companyId, party (customer / supplier), amount, side (Dr / Cr), go-live date,
   source (file, reference, original party name / code), optional bill reference + bill date + due date
   (bill-wise outstanding), created by / at. Unique per party + bill reference (duplicate protection).
2. Settlement: receipts / payments allocatable to an opening entry (e.g. `Payment.invoiceType = 'OPENING'`
   with the entry id), with the same row-locked `paidAmount` / status logic invoices use; plus genuine
   on-account receipts (fixing the "Advance / on account" mismatch).
3. Reports read the entries, not the party field: `partyOutstanding`, party 360, statements (entry dated at
   the go-live opening timestamp), ageing by bill date, balance sheet opening difference.
4. Migration of existing non-zero `openingBalance` values into entries (one undated entry each), then the
   party-form field becomes read-only.
5. Then the import writes entries through that service, with reconciliation against the source totals.

Cash / bank opening balances already have a dated model (`MoneyAccount.openingBalance` + `openingDate`) and
could be imported next with little risk.
