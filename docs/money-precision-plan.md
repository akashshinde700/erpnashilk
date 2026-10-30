# Money & quantity precision — the `Decimal` migration plan (DB-01)

Status: **plan only.** Nothing in this file has been applied. The audit left the schema as it is on purpose: changing
153 columns across 52 models is a release of its own, and it cannot be verified without a database.

---

## Why

`prisma/schema.prisma` declares **153 `Float` (MySQL `DOUBLE`) columns** — every money value (`grandTotal`, `cgst`,
`lineTotal`, `rate`, `paidAmount`, `openingBalance`, …) and every quantity (`qty`, `producedQty`, `issuedQty`, …).

`DOUBLE` is binary floating point: `0.1 + 0.2 !== 0.3`. The app already defends at the two places that matter most:

* `computeBillTotals()` / `computeGst()` do all bill arithmetic in **integer paise** (fixed by BILL-01), so a bill's
  lines, tax heads and grand total agree to the paisa;
* `postStock()` rounds every quantity move with `r2()` before writing.

What is still exposed:

1. **Aggregates in SQL.** `SUM(grandTotal)`, `SUM(qty)` on float columns accumulate binary error; a year of invoices can
   drift by paise, and `WHERE amount = 0` style comparisons are unreliable.
2. **Comparisons.** `paidAmount >= grandTotal` can be false when the two are "equal" but stored as `11800.000000001`.
   Payment allocation already uses a tolerance; a stricter column would remove the need.
3. **Rounding in reports.** `gstTotals()` re-rounds after summing floats; with `DECIMAL` the sum is exact before rounding.

## Target

MySQL `DECIMAL(18,4)` for money and quantities (4 dp matches the app's quantity rounding and Tally's tolerance).
Rates and percentages (`gstRate`, `scrapPct`, `discountPct`, `fxRate`) stay `DECIMAL(9,4)`; counters/limits that are
not money (`reorderLevel`, `minStock`, `maxStock`) can stay float if that keeps the change smaller.

## How Prisma behaves (this is the part that bites)

With `@db.Decimal(18, 4)` Prisma returns **`Prisma.Decimal` objects**, not `number`. `Decimal + 0.5` throws at runtime.
So the schema change and the code change must ship together:

```ts
// src/lib/num.ts (new) — one place that converts a Decimal / number / string to a number
export const num = (v: unknown): number => {
  if (v === null || v === undefined) return 0
  if (typeof v === 'number') return v
  if (typeof v === 'string') return Number(v) || 0
  const d = v as { toNumber?: () => number; toString: () => string }
  return d.toNumber ? d.toNumber() : Number(d.toString()) || 0
}
```

Then every read path that touches a money column goes through `num(...)` before arithmetic or `JSON.stringify`
(Prisma's Decimal serialises as a string, which would silently change the API contract: `"11800.0000"` instead of
`11800`).

## Order of work (each step its own commit, each step deployable)

1. **Freeze the contract with tests.** Snapshot the JSON of `GET /api/sales-invoices`, `/api/reports/gst2`,
   `/api/stock`, `/api/dashboard` (a fixture test) so a type change cannot slip through unnoticed.
2. **Add `num()`** and use it on the paths that are *already* returned to the UI (routes that `select` money columns) —
   behaviour identical today, because the values are still numbers.
3. **Migrate one model at a time**, cheapest first: `Item` → `StockBalance` → `StockLedger` → invoice/order line tables
   → invoice headers → payments/loans. After each model: `next build`, full Playwright suite, `bun test`.
4. **Write the migration**, not `db push`:

   ```sql
   ALTER TABLE SalesInvoice
     MODIFY grandTotal DECIMAL(18,4) NOT NULL DEFAULT 0,
     MODIFY cgst       DECIMAL(18,4) NOT NULL DEFAULT 0,
     …;
   ```

   MySQL converts `DOUBLE → DECIMAL` by rounding to the column scale, which is exactly what `r2()` already did in the
   app. Run it in a **single transaction per table**, after a `mysqldump`, in a low-traffic window.
5. **Reconcile.** After each table, compare `SELECT SUM(ROUND(col,2))` before and after the ALTER (from the dump vs the
   live table). Any difference is a real bug, not noise — stop and investigate.
6. **Retire `r2()`** only where the value is stored; keep it for display and for the paise maths in `computeBillTotals()`
   (integer paise is still the right way to reason about a bill).

## Verification for the migration PR

* Full Playwright suite (128 tests today) — invoices, returns, stock, GST reports, Tally export.
* `bun test` against the guarded test database (money assertions in `cash-bank-*`, `sales-return-cost`).
* A reconciliation script run on a **copy** of production: per-table `SUM` before/after, plus a per-invoice check that
  `grandTotal = Σ lineTotal + charges + tax ± roundOff`.
* The backup → restore drill (`docs/release-checklist.md`) on the migrated copy.

## Rollback

Keep the pre-migration dump. `DECIMAL → DOUBLE` is lossless, so a rollback is `ALTER … MODIFY col DOUBLE` plus deploying
the previous build. Because that is a second schema change, the migration and the code release should be the *same*
deploy, with the dump taken immediately before.

## Risk register

| Risk | Mitigation |
|---|---|
| A route returns `"11800.0000"` instead of `11800` → UI shows strings, totals explode | `num()` at the serialisation boundary + fixture test from step 1 |
| `Decimal` arithmetic throws somewhere deep in a report | migrate per model, full suite after each; `tsc` will point at the untyped spots once types are real |
| MySQL rounding on ALTER differs from app rounding | reconcile per table against the dump before switching traffic |
| Long `ALTER` locks a big table | run per table in a window; `pt-online-schema-change` if a table is too big to lock |
| 153 columns is a big diff to review | one model per commit, mechanical and reviewable |
