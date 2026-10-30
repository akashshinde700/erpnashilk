# Production audit — 2026-10-30

Scope: the whole ManuFlow ERP repository (`main` @ `2f1846c`, branch `arena/bd8a2be0-erpnashilk`).
Audit type: architecture, manufacturing domain logic, billing, transactions, security, DB, tests, UI.
**Nothing in this audit touched production data, credentials or infrastructure.**

---

## 1. What the system is (discovered, not assumed)

| Layer | Reality |
|---|---|
| Stack | Next.js 16.4.3 App Router (React 19) · Prisma 6.19.3 · MySQL · shadcn/radix UI · Tailwind |
| Size | **128** API route handlers · **40** ERP screens · **52** Prisma models · 58 `@@index` · 31 `@@unique` |
| Auth | server-side session cookie + role (`ROLE_MODULE_KEYS`), `requireRead` / `requireWrite` on every route, per-company scoping via `companyRequired()` / `assertCompanyAccess()` |
| Money/stock | single `postStock()` primitive (immutable `StockLedger` + `StockBalance`), `computeBillTotals()` for every bill/invoice, `gstTotals()` for returns |
| Tests | 10 browser specs + 4 unit specs (Playwright) · 26 DB-backed `bun test` files |

### Modules that actually exist

Masters (items, parties, warehouses, machines, BOM, users) · Purchase (requisition → PO → GRN → bill → debit note) ·
Sales (enquiry → quotation → SO → challan → invoice → payment → credit note) · Inventory (stock, ledger, transfers,
adjustments, batches, serials) · Manufacturing (**work orders → material issues → production entries (with backflush) →
QC inspections → MRP**) · Finance (accounts, cash & bank, payments, expenses, loans, outstanding, GST returns,
e-invoice, Tally export/import) · Administration (settings, numbering, audit log, import center, platform admin).

### Modules the brief mentions that do **not** exist (so they cannot be audited/fixed)

`Job cards`, `inward/outward (job-work) entries`, `certificates`, `weight (kg) tracking`, `lot charges`,
`per-kg/per-piece rate rules`, `process-wise WIP`. The equivalents here are **work orders**, **material issues**,
**production entries**, **delivery challans** and per-line `qty × rate` billing. Reported as a scope gap, not as a bug —
no code was invented for them.

---

## 2. Issues found

| ID | Sev | Module | Issue | Status |
|---|---|---|---|---|
| **BILL-01** | High | Billing / print / GST | A bill-level discount was spread over the lines with unrounded division and the totals were rounded separately, so **Σ(printed line taxable) ≠ bill taxable by 1 paisa** (reproduced: 3 × ₹100 with ₹1 bill discount → lines 299.01, bill 299.00, total 352.82 vs 352.83). Same class of gap in `computeGst()` for quotations/POs. Ledger/GSTR-1 comparisons trip on exactly this. | **Fixed** |
| **TXN-01** | High | Manufacturing / stock | `POST /api/production-entries` read the work order without a row lock. Two concurrent submissions both read the old `producedQty`, both passed the planned-qty check, **both posted finished-goods stock and both backflushed raw material**, while the work order counted only one of them (lost update) → stock inflation and duplicated consumption. | **Fixed** |
| **TXN-02** | Medium | Manufacturing / stock | `POST /api/material-issues` had the same read-then-write shape as TXN-01, but the real risk is the **cross-route** one: a material issue and a production entry on the same work order could interleave, and `backflushComponents()` reads "already consumed" (issues + earlier backflushes) *outside* any lock — so a component could be consumed twice, or not at all. The per-line +5 % cap is a single-request check (not cumulative), so it was never the concurrency problem. `postStock()` still prevented negative stock, which bounded the damage. | **Fixed** — both routes now take the same work-order row lock, so issue and backflush serialise |
| **TXN-03** | Medium | Manufacturing / inventory | Only 9 money routes used `Idempotency-Key`; **material issues, production entries, stock adjustments and stock transfers did not**, so a double click or a network retry posted the stock movement twice (the UI disables the button, which is not a guarantee — a retried request still arrives). | **Fixed** — `claimIdempotency()` on all four routes; the response is stored in the same transaction as the documents, a retry returns the original response, a reused key with a different payload is rejected (422) and a failed request releases its claim |
| INV-01 | — | Manufacturing / stock | Investigated the suspicion that the backflush (`need − issued − backflushed`, recomputed per entry) could over-consume a component or drive stock negative. **Code-verified as safe, no change made:** the deduction is clamped to positives, the full shortage list is raised as a 409 *before* any row is posted, and the manual-issue side is separately capped at +5 %. The remaining nuance — a manual issue above the exact requirement reduces later backflush rather than being netted line-by-line — is inherent to a BOM-total requirement and is **not** a stock-integrity defect. | Verified, no defect |
| DB-01 | Medium | Database | Money/quantity columns are `Float`/`Double`, not `Decimal`. Paisa-exact arithmetic is now done in integer paise inside the bill builder, but aggregates elsewhere (reports, `SUM()`) are still float. A `Decimal(18,4)` migration is a **schema change with data migration** — needs a separate, approved release. | Open (documented) |
| RPT-01 | Low | Reports | `stockValueBefore()` values historical stock at the **current** moving-average rate (stated in the code) — historical valuation is an approximation. | Open (by design) |
| TEST-01 | Medium | QA | 26 `bun test` suites need MySQL + bun; **this sandbox has neither**, so they could not be executed here. They are untouched by these fixes. | Open (environment) |
| UI-01 | Low | UI | Buttons that create stock/financial documents were verified to disable while saving (`FormDialog loading`), so double-click is blocked at the UI layer; the API now also serialises (TXN-01/02). | Verified |

No **Critical** issue was found: no authentication/authorization bypass, no IDOR, no injection, no stock-into-negative path,
no swallowed exception returning a false success.

---

## 3. What was fixed, file by file

### BILL-01 — paisa-exact bill totals
`src/lib/erp-helpers.ts` — `computeBillTotals()` and `computeGst()` rewritten to work in **integer paise**:

1. each line's gross and line discount are rounded once; the bill discount is allocated pro-rata with the
   **largest-remainder method**, so `Σ line taxable === bill taxable` exactly;
2. tax and cess are computed from the *rounded* line value; intra-state splits per line so
   `CGST + SGST === that line's tax` (an odd paisa goes to CGST);
3. freight / packing are taxed as rounded charge amounts;
4. the grand total is the sum of the stored line values + charges, so **print == saved row == report**;
5. `roundOff` still snaps to the rupee, and is bounded to ±50 paise of the exact total.

The same function is used by the invoice/purchase/credit-note server routes **and** the browser preview, so the number
the user sees before saving is the number that is stored.

### TXN-01 / TXN-02 — serialise entries on one work order
`src/app/api/production-entries/route.ts`, `src/app/api/material-issues/route.ts`:
a no-op `updateMany({ data: { producedQty: { increment: 0 } } })` is executed as the **first statement** of the
transaction. In MySQL/InnoDB that takes the work-order row lock, so the second request waits, then reads the committed
quantities (current read) — the same lock technique `postStock()` already documented for stock rows. The planned-qty
guard, the backflush plan and the status transition now see each other's writes.

---

## 4. Verification actually executed

| Command | Result |
|---|---|
| `next build --webpack` (`NEXT_SKIP_TYPECHECK=1`) | ✅ compiled, 88/88 pages |
| `npx playwright test` (chromium + unit) | ✅ **121 passed** (was 115; +6 new billing tests) |
| Regression proof: same new spec against the **old** `erp-helpers.ts` | ❌ 3 of 6 fail (bug reproduced) → ✅ all pass with the fix |
| `npx eslint` on every changed file | ✅ clean |
| `npx tsc --noEmit` | 219 errors — all pre-existing Prisma-stub noise (this sandbox cannot download the Prisma engine; baseline 219/222 without these edits). **No new errors from this change.** |
| `node --check scripts/daily-backup.mjs` | ✅ syntax OK |
| `tests/*.test.ts` (bun + MySQL) | ⛔ **not run** — no MySQL and no bun in this environment. Not claimed as passing. |
| Concurrency + idempotency tests → `tests/production-concurrency.test.ts` | ⛔ **written, not executed** — needs the guarded MySQL test database (`TEST_DATABASE_URL`, `bun run test:db:prepare`, `bun test`). Five cases: two parallel entries for the full planned qty, five parallel entries, retried submission replayed, same key with a different payload refused, failed entry releases its key. |
| Two-request race proof (TXN-01/02) | ⛔ **not executed here** — no MySQL. Code-verified (InnoDB row lock on a matched `UPDATE`); the test above is the executable proof to run on staging. |
| Prisma migrate / `db:push` | ⛔ not run — no database; no schema change was made by this audit, so nothing to apply |

New regression tests: `e2e/unit/billing-totals.spec.ts` — 6 cases, including a deterministic 400-bill property test
(random lines, discounts, cess, freight, packing, round-off in both intra- and inter-state) that asserts, in integer
paise: line column ↔ bill taxable, tax heads ↔ Σ line tax + charge tax, grand total ↔ printed components, cap behaviour,
zero-qty/empty bills.

---

## 4a. Database backup & recovery (checked, not assumed)

| Item | Finding |
|---|---|
| Tenant JSON backup | `GET /api/companies/[id]/backup` — admin-only (`TENANT_ADMIN`/`MANAGEMENT`/`SUPER_ADMIN`), `:id` must equal the resolved tenant, every table fetched tenant-scoped, **`passwordHash` omitted**, streamed as a download with `meta.version`. Settings → Data & Backup downloads it in the browser. |
| Scheduled backup | `scripts/daily-backup.mjs` — same snapshot, gzipped to `~/backups/manuflow/<date>/<companyId>.json.gz`, retention `BACKUP_KEEP_DAYS` (14 by default), non-zero exit on any failure so cron/monitoring sees it. Syntax checked (`node --check`); **not executed here** (no database). |
| Restore | `POST /api/companies/[id]/restore` + Settings → Restore: admin-only, `meta.version` must be 1, the company name must be typed exactly, the file's `meta.companyId` must match, a fresh backup of the current data is downloaded **before** anything is deleted, and the replace runs in one transaction with batched inserts. |
| Full-server recovery | Not in the app: pair the nightly JSON backups with normal `mysqldump`/managed-DB point-in-time recovery. Documented; **not changed** (infrastructure is out of scope without an explicit request). |
| Drill | ⛔ **Not performed** — restoring into a real database is destructive and this audit was not authorised to touch one. Do it once on staging before go-live: download → restore → compare `meta.counts` with the post-restore row counts. |

---

## 4b. Performance

* Indexes reviewed on the hot tables: `StockLedger` (`companyId+itemId`, `companyId+date`, `refType+refId`,
  `companyId+warehouseId`), `StockBalance` (`itemId+warehouseId` unique), invoices/payments/GRNs (`companyId+date`,
  `companyId+status`), `WorkOrder`, `AuditLog`. Relation columns are covered by InnoDB foreign-key indexes.
* Document posting is the heaviest path: one transaction, batched `createMany`, a `postStock()` row lock per item
  (deliberate, to stop oversell), and a 30 s transaction timeout set in `src/lib/db.ts`.
* List endpoints use `include`/`take`/`skip` rather than per-row queries; the report routes aggregate in SQL.
* No change made — no measured bottleneck, and this sandbox has no production-scale dataset to benchmark against.

---

## 4c. UI / UX

Screens grouped into hubs (Sales, Purchase, Inventory, Manufacturing, Finance, Utilities, Admin) with a command
palette, keyboard-shortcut help, ⌘K search, inline validation and consistent empty states. Destructive actions
(delete/cancel/reverse) are confirmed; documents keep their existing print layouts (A4/A5 GST invoice, 58/80 mm receipt,
delivery challan, purchase documents). Two guard rails were verified: every create/update dialog disables its submit
button while the request is in flight, and money screens preview totals with the **same** `computeBillTotals()` the
server uses — so the preview now inherits the paisa-exact fix automatically.

---

## 5. Business scenarios — what was and was not verified

| # | Scenario | Status |
|---|---|---|
| 1 | Customer/vendor → items → PO → GRN → stock | ✅ covered by existing browser specs (`03`, `05`) |
| 2 | Inward with several items, allocation across several work orders, remaining qty | ⚠️ partly: material issues + over-issue guard (5%) + `postStock` re-check are covered by specs; **weight is not modelled**, so "remaining weight" cannot exist |
| 3 | Job card through processes, output/reject/rework, WIP | ⚠️ adapted: work order → material issue → production entry (backflush, reject, scrap) exists; **no process-wise WIP or rework counter** in the data model |
| 4 | Complete job card → certificate → invoice → printed document | ⚠️ adapted: production completion → sales invoice (stock deducted, GST split, A4/A5/thermal print) is covered; **certificates do not exist** |
| 5 | Payment → invoice balance → customer balance → reports | ✅ covered by specs + `gstTotals`/ledger unit tests |
| 6 | Edit / cancel a transaction → stock and balances consistent | ✅ code-verified (`reverseSaleStock`, material-issue cancel, GRN cancel all post reversing rows inside the same transaction) |
| 7 | Duplicate submission, invalid qty, unauthorised access, simultaneous stock updates | ✅ mostly — `postStock` row lock + negative guard, idempotency keys on money routes, RBAC on every route; **simultaneous-update proof needs a database** (see §4) |
| 8 | Dashboard/report reconciling with transactions | ✅ financially: `gstTotals()` and the P&L/balance sheet read the same ledger rows; ⚠️ historical stock valuation is approximate (RPT-01) |

Security spot-checks performed (static, non-destructive): every `findUnique({ id })` that is not tenant-scoped was
traced — all sit behind `assertCompanyAccess()` / a company-scoped parent row, or are platform-admin-only routes.
Session cookies are httpOnly + sameSite, passwords are hashed with a versioned scheme, login is throttled,
connector endpoints authenticate by hashed token, and the Tally push path refuses server-unbuilt XML (see
`docs/tally-connector.md`).

---

## 6. Release readiness

**READY WITH KNOWN RISKS.**

Blocking-for-release: none outstanding from this audit.
Carry-forward risks (all documented above):

1. **DB-01** money/qty columns are floats — needs an approved `Decimal(18,4)` migration with data conversion.
2. **RPT-01** historical stock valuation uses today's average rate.
3. **Concurrency proof for TXN-01/02** must be re-run against a real MySQL on staging (two parallel submissions);
   the lock is standard InnoDB behaviour but was not executed here.
4. **27 `bun test` suites** (26 existing + the new concurrency/idempotency suite) need MySQL + bun; run them, then do
   the **backup → restore drill** on staging
   (`Settings → Data & Backup`, or `node scripts/daily-backup.mjs` + restore) before go-live.
5. **Scope** — weight (kg) tracking, lot charges, process-wise WIP, job cards and certificates do not exist in this
   data model; they are features, not defects, and were not invented.
