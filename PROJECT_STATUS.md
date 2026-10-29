# ManuFlow ERP — Cash & Bank project status

_Last updated: 2026-10-27. Branch `feature/smart-import-center` (HEAD `d1dccbe`). **Deployed to production 2026-10-26 ~01:17 IST** (Phases 1–4, AC-B1, Import Center English UI) on the user's explicit request. **Phase 5 is done locally only — not deployed.** Nothing since `d1dccbe` is committed in git._

Goal: a Vyapar-simple Cash & Bank module that fits a manufacturing ERP — reuse the existing models
(`MoneyAccount`, `AccountTxn`, `Loan`, `Payment`, `Expense`) and the derived-balance design in
`src/lib/accounts.ts` (balances are computed from documents, never stored).

Rules for every phase: no production writes, schema changes, backfills or deploys without explicit approval;
tests run only on the guarded throwaway test database; each phase stops for review.

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 0 | Characterization tests + read-only production counts | **Done** (2026-10-25) |
| 1 | Opening date rules, account selection, DRAFT expenses, post-dated cheques, Cash in Hand creation, IST dates | **Deployed** 2026-10-26 (done 2026-10-25) — not committed |
| 1b | Backfill the one legacy payment without `accountId` (data only) | **Pending — needs separate approval** (CB-R10) |
| 2 | Unified transaction history API with filters (account, type, party, date, search) + running balance; CB-R3; CB-R4 | **Deployed** 2026-10-26 (verified 2026-10-25: 190/190 tests, type checks, ESLint, build) — not committed |
| 3 | Vyapar-style UI: Money In / Money Out / Adjust Cash ("actual cash counted") / Bank Transfer / Add Bank popups; CB-R5 | **Deployed** 2026-10-26 — not committed |
| 4 | Customer advances + sales / purchase return refunds (CB-R8) | **Deployed** 2026-10-26 — not committed |
| 5 | CB-R1 numbering, read + payment-kind permissions, negative-cash protection, duplicate warnings, idempotency, supplier statement fix | **Done locally** (2026-10-27) — all required local checks pass (see "Cash & Bank Phase 5" below); **not committed, not deployed**; `IdempotencyKey` table exists only in the local test databases |
| 6 | Staging → verified backup → production deploy (on explicit request only) | **Not started** — needs explicit approval |

## Done

### Phase 0
- `tests/cash-bank.test.ts`: characterization tests for every money flow (opening balance, Payment In/Out,
  expense, adjustment, contra, post-dated cheque clear/bounce, loan/EMI, credit/debit notes, tenant isolation).
- Read-only production check (READ ONLY session, `@@transaction_read_only = 1` guard, counts only):
  2 companies, 1 payment (`accountId` null, CASH), 0 expenses, 3 money accounts, 4 account entries, 1 loan;
  all 17 integrity checks 0. Findings: CB-R6, CB-R10.

### Phase 1
- `src/lib/business-date.ts`: business dates stored at UTC midnight of their IST day.
- `src/lib/accounts.ts`: `postingAccount` (a chosen account must exist and be active — never swapped),
  `ensureCashFor` (Cash in Hand created before the transaction, race-safe), `assertOnOrAfterOpening`,
  `chequeDetails`, `moneyPaymentWhere` / `moneyDate` (cleared post-dated cheque counts on its clearing date),
  POSTED-only expenses; reading balances creates nothing.
- Routes: accounts, statement, reconcile, account-txns, payments (+ cheque actions), expenses, loans/EMI,
  sales and purchase invoices ("received / paid now", incl. cheque no. and date).
- Reports (`src/lib/accounting.ts`): P&L, GST ITC, cash flow, balance sheet "cheques in hand", transactions
  use POSTED expenses and cheque clearing dates.
- UI: "Set up Cash in Hand", opening date required with an opening balance, cheque fields on invoices and bills.
- Tests: `tests/cash-bank-phase1.test.ts` (24). Full suite 176/176; TypeScript, ESLint and production build clean.

### Phase 2 (2026-10-25)
- `src/lib/cash-bank-ledger.ts` (new): every money movement per account (a transfer = an out row + an in row) with the
  account's running balance; same rules as `accountBalances()` (opening on its date, cleared post-dated cheque on its
  clearing date, POSTED expenses only, no credit/debit notes or pending/bounced cheques, legacy rows on the default account).
- `src/app/api/cash-bank/transactions/route.ts` (new): history API — filters account / type / party / from / to / search;
  opening (balance before `from`) and closing (balance at `to`) are the whole account's, not narrowed by type / party /
  search (`filtered` flag); summary of cheques not cleared yet; 400 on unknown type or from > to, 404 on an unknown or
  other company's account.
- `src/components/erp/modules/cash-bank.tsx`: "Transactions" tab — Account / Type / Party / From / To filters, table
  search, balance-before / money in / money out / balance-on cards, per-row balance when one account is selected, CSV export.
- CB-R3: `sales-invoices/route.ts`, `sales-invoices/[id]/route.ts`, `purchase-invoices/route.ts`,
  `purchase-invoices/[id]/route.ts` store the document date with `businessDate()` (create and edit). Behaviour change:
  an invalid date is refused (400) — a purchase bill used to fall back to "now" silently.
- CB-R4: `src/lib/accounting.ts` `listTransactions` (daybook + transactions report) — a cleared post-dated cheque's
  money is on a new `CHEQUE_CLEARED` row ("Cheque Cleared") dated on its clearing date; the payment-date row keeps the
  settlement with no money. `reports.tsx`: colour for the new type.
- Tests: `tests/cash-bank-phase2.test.ts` (14 tests; earlier notes said 15 — that was a miscount; the 14th, a GST-totals
  check for CB-R3, was added during verification). One test type error (a possibly-undefined value in an assertion)
  was fixed in the test; no application fix was needed.

Verification (actual results, 2026-10-25):

| Check | Result |
|---|---|
| Phase 2 tests (`bun test tests/cash-bank-phase2.test.ts`) | **PASS** — 14/14 |
| Full suite (`bun test`) | **PASS** — 190/190 across 19 files |
| App TypeScript (`npx tsc --noEmit -p tsconfig.json`) | **PASS** — only the 4 pre-existing errors in `examples/`, `mini-services/` (not deployed) |
| Test TypeScript (`bun run test:types`) | **PASS** — 0 errors (after the test fix above) |
| ESLint (changed files, incl. `react-hooks/refs`) | **PASS** — 0 errors; 1 pre-existing warning (unused eslint-disable, `purchase-invoices/[id]/route.ts:97`) |
| Production build (deploy file set) | **PASS** |
| Browser check (local build, throwaway seeded DB) | **PASS 10/11** — Transactions tab, filters, rows, API closing = account total, no Balance column for all accounts / shown for one account, no horizontal scroll at 390 px, no page errors. The 11th check (summary text) failed because of the check script (it read the first tab panel and compared case-sensitively against uppercase card titles); the summary cards were confirmed on the desktop screenshot (₹0 + ₹89,016 − ₹49,000 = ₹40,016 = cash in hand). |

Earlier attempts the same day were BLOCKED by the tool's safety check ("auto mode classifier gave no verdict"); it was
not bypassed — the checks above ran once the shell was available again.

Phase 2 acceptance criteria — met:
- History: all money movements, filters (account, type, party, date, search), running balance matching
  `accountBalances()`, tenant isolation — tested.
- CB-R3: document dates via `businessDate()`; invoice / bill and their "received / paid now" payment on the same IST day;
  P&L, GST totals and daybook for that day include them; date-only input unchanged — tested.
- CB-R4: cleared post-dated cheque money on its clearing date in the daybook; the payment-date row shows no money;
  daybook money for a period equals the cash-flow movement (opening balances of new accounts excluded, as they are not
  documents); the history agrees — tested.

Phase 2 residual risk (new, not blocking): the history builds every account's full ledger on each request — fine at
today's data size; needs database-side aggregation as data grows.

## Unresolved requirements

| ID | Requirement | Status | Phase |
|---|---|---|---|
| CB-R1 | Document numbering must not exhaust the connection pool | **Done locally** (Phase 5, verified) | 5 |
| CB-R2 | A bounced same-day cheque must not rewrite past statements | Open | 4 |
| CB-R3 | Invoice and bill dates normalised to their IST day | **Done locally** (Phase 2, verified) | 2 |
| CB-R4 | Daybook / transactions show post-dated cheque money on its clearing date | **Done locally** (Phase 2, verified) | 2 |
| CB-R5 | Payment mode and account type must agree | **Done locally** (Phase 3, verified) | 3 |
| CB-R6 | Production account with an opening balance but no opening date | Open (data, user action) | 1b |
| CB-R7 | Viewer and other non-finance roles cannot read financial APIs | **Done locally** (Phase 5, verified) | 5 |
| CB-R8 | Refunds of credit / debit notes recorded as money | **Done locally** (Phase 4, verified) | 4 |
| CB-R9 | Cash must not go negative (decided: block, Tenant Admin / Super Admin override) | **Done locally** (Phase 5, verified) | 5 |
| CB-R10 | Legacy payment without `accountId` backfilled | Open — needs approval | 1b |

### CB-R1 — `nextDocNumber` / `docPrefix()` connection-pool timeout
- **Problem:** `docPrefix()` (and the first-number `createMany`) in `nextDocNumber` read through the global
  Prisma client inside an interactive transaction, so each transaction needs a second pool connection. Bursts of
  concurrent documents the size of the pool time out with P2024 in any module (seen with 5 connections in tests).
- **Files:** `src/lib/erp-helpers.ts` (`docPrefix`, `nextDocNumber`); every route that numbers documents.
- **Acceptance:** numbering inside a transaction uses only that transaction's connection, or the prefix is
  resolved before the transaction; numbers stay unique and gap-free under concurrency; no P2024.
- **Tests:** 2× pool-size concurrent first documents of a new financial year → all succeed, distinct sequential
  numbers; existing numbering and import-concurrency tests unchanged.

### CB-R2 — Same-day cheque bounce changes historical statements
- **Problem:** a non-post-dated cheque counts on its payment date; when it bounces later it drops out from that
  date, so statements and closing balances already reported change.
- **Files:** `src/lib/accounts.ts` (`moneyPaymentWhere`), `src/app/api/payments/[id]/route.ts` (bounce),
  `src/app/api/accounts/[id]/statement/route.ts`, `src/lib/accounting.ts` (cash flow).
- **Acceptance:** the original receipt stays on its date; the bounce is a separate outflow on the bounce date;
  balances for dates before the bounce do not change; the invoice reopens as today.
- **Tests:** balance as of the payment day is the same before and after the bounce; balance after the bounce date
  is reduced; the statement shows both rows; cash flow `difference` stays 0.

### CB-R3 — IST normalisation of invoice and bill dates
- **Problem:** sales invoice and purchase bill documents keep `new Date(body.date)` / `new Date()`; only their
  payment rows are normalised, so a document saved between 00:00 and 05:30 IST can fall outside its day in reports.
- **Files:** `src/app/api/sales-invoices/route.ts`, `src/app/api/purchase-invoices/route.ts` (+ their `[id]` edit routes).
- **Acceptance:** document dates use `businessDate()`; the invoice and its "received / paid now" payment carry
  the same IST day; GST and P&L reports for that day include the document.
- **Tests:** invoice created at 00:30 IST with no date → stored as that IST day, in that day's sales report and
  GST totals; date-only input unchanged.

### CB-R4 — Daybook shows post-dated cheque money on the payment date
- **Problem:** `listTransactions` (daybook / transactions report) puts a cleared post-dated cheque's money on the
  payment date, while balances and cash flow use the clearing date.
- **Files:** `src/lib/accounting.ts` (`listTransactions`), transactions/daybook report route and UI.
- **Acceptance:** money in/out of a cleared post-dated cheque appears on its clearing date; the payment-date row
  shows the settlement with no money; daybook money totals for a period equal the cash-flow movement.
- **Tests:** post-dated cheque recorded on day A and cleared on day B → daybook money on B only; period totals
  match `cashFlow()`.

### CB-R5 — Payment mode vs account type mismatch
- **Problem:** an explicitly chosen account is not checked against the mode (e.g. CASH into a bank account,
  UPI into a cash account).
- **Files:** `src/lib/accounts.ts` (`postingAccount`), payments, expenses, sales/purchase invoice routes; forms
  that list accounts (filter by mode).
- **Acceptance:** CASH ↔ cash accounts, other modes ↔ bank accounts, with a clear 400 message; forms offer only
  matching accounts. Decide before building whether UPI into a cash account is ever allowed.
- **Tests:** each mismatch refused on every route; matching pairs accepted; existing records untouched.

### CB-R6 — Production account with an opening balance but no opening date
- **Problem:** found in Phase 0 — 1 production account. Its opening balance counts for every historical date;
  editing its balance now asks for a date.
- **Files:** none (data). UI: Cash & Bank → edit account.
- **Acceptance:** the owner enters the correct opening date in the UI (no script backfill); a read-only
  re-check finds 0 such accounts.
- **Tests:** covered — `cash-bank-phase1.test.ts` ("older account with a balance but no date…").

### CB-R7 — Financial API read permissions
- **Problem:** GET routes check only the tenant, so any signed-in user (VIEWER, OPERATOR…) can read balances,
  bank details and statements through the API.
- **Files:** `src/lib/erp-helpers.ts` (add a read guard), `src/app/api/accounts/**`, `account-txns`, `loans`,
  `payments`, `expenses`, report routes; `ROLE_MODULE_KEYS` in `src/lib/erp-constants.ts`.
- **Acceptance:** reads require access to the module (`cash-bank`, `payments`, `expenses`, `reports`); 403
  otherwise; the dashboard hides cash/bank figures for roles without access.
- **Tests:** VIEWER / OPERATOR → 403 on each financial GET; ACCOUNTANT → 200; flip the Phase 0
  "viewer can still read balances" test.

### CB-R8 — Refund handling
- **Problem:** a return beyond the invoice's outstanding records "refund due" only in the audit text; no money is
  recorded, so cash and party balances diverge when the refund is paid.
- **Files:** `src/app/api/sales-returns/**`, `src/app/api/purchase-returns/**`, `src/app/api/payments/route.ts`
  (refund payment without an invoice), `src/lib/accounting.ts` (party balances), UI for returns.
- **Acceptance:** "Refund" records a payment (customer refund = money out; supplier refund = money in) against the
  return, limited to the refund due, from/to a chosen account; cancelling the return or voiding the refund reverses it.
- **Tests:** refund lowers cash and clears the due; over-refund refused; void restores; flip the Phase 0
  "refund due … not recorded" test.

### CB-R9 — Negative cash warning
- **Problem:** cash can go below zero without any warning.
- **Files:** `src/lib/accounts.ts` (balance-at-date helper), money-out routes (expense, Payment Out, ADJUST_OUT,
  contra, EMI), their forms.
- **Acceptance:** when an outflow would take a CASH account below 0 on its date, the API refuses unless the request
  confirms it (`allowNegative: true`); the form shows the balance and asks for confirmation. Bank overdrafts
  are not blocked.
- **Tests:** outflow over the cash balance → 409 with the balance; same with confirmation → saved; bank outflow
  unaffected; flip the Phase 0 "cash can be reduced below zero" test.

### CB-R10 — Phase 1b: legacy payment backfill
- **Problem:** 1 production CASH payment has `accountId` null; it follows whichever cash account is default.
- **Files:** none in code; a one-off, reviewed script (read-only dry run first).
- **Acceptance:** right account decided from business context (not because it is the default) and approved;
  verified backup; one `UPDATE` matching exactly that row; every account's balance identical before and after;
  0 payments with null `accountId` (excluding credit/debit notes).
- **Tests:** dry run prints the row and the target account and changes nothing; post-change read-only check of
  balances and counts; existing test "a payment with no accountId follows whichever bank is default now" stays
  as the guard for any future legacy rows.

## Other open items from the original request (unchanged)
- Transaction history with filters — done in Phase 2. Money In / Money Out, Adjust Cash, Bank Transfer popups — done in Phase 3.
- Payment In/Out without an invoice (advances) — Phase 4.
- Duplicate-transaction protection — done locally in Phase 5 (confirmable duplicate warning + Idempotency-Key table).
- Optional later, separate approval: `PaymentAllocation` table, Decimal money columns.

---

# Tally integration — Phase 0 assessment (2026-10-25)

Assessment only: no code, configuration, installs, network connections or production data were touched.

## Verified facts (from this repository)
- **Diagnostics only exist.** `src/lib/tally/client.ts` (`checkTally`: one harmless XML POST, 4 s timeout, 256 KB cap,
  no redirects, DTD/entities refused), `GET /api/import-center/tally/status` (Import Center access; address only from
  the server setting `TALLY_HTTP_URL`, never from the request — SSRF guard), `tests/tally.test.ts` (mock server only),
  design note `docs/tally-connector.md`. No company listing, no data import from Tally.
- **Deployment is cloud** (CloudPanel, `deploy.py`); `TALLY_HTTP_URL` is unset there, so the status is "not configured".
  A cloud server cannot reach a customer PC's `localhost:9000`; a browser page cannot either (no CORS, private network).
- **Import pipeline to reuse:** upload/parse → preview (dry run of the same services, nothing saved) → explicit confirm →
  commit (per-row transaction, company row lock, duplicate re-check) → history in the audit log
  (`src/lib/import/*`, `src/lib/services/*-import.ts`, `src/app/api/import-center/*`).
- **Importable today:** customers, suppliers, items, opening stock (at the go-live date). Opening party balances:
  check-only (`commit: false`, `docs/opening-balances.md`). Sales, purchases, receipts, payments, notes, company info:
  not available.
- **Tally files already work:** column aliases cover Tally exports ("Ledger Name", "Stock Item", "Godown",
  "Closing Quantity", "GSTIN/UIN"…); the Import Center's Tally card recommends Excel/CSV export.
- **No stable external key:** the schema has no field for a Tally GUID / master id, so re-imports can only match by
  name / code / GSTIN.

## Assumptions (from Tally documentation as recorded in `docs/tally-connector.md` — not verified against a real TallyPrime)
- TallyPrime serves XML over HTTP POST when "TallyPrime act as" = Server/Both, default port 9000, a company loaded.
- The interface has no authentication; anyone who can reach the port can read the loaded company's books.
- Requests for company list, ledgers with groups, stock items (units, HSN/GST), godown-wise closing stock and their
  reply layouts are stable enough across releases — **unverified**; must be captured from real installations first.

## Integration options for this architecture
| Option | Fit | Verdict |
|---|---|---|
| A. Tally → Excel/CSV export → Import Center | Works today, no install | **Keep as the default path** |
| B. Local connector on the Tally PC, outbound HTTPS to ManuFlow (polling), allow-listed jobs | Works with cloud ManuFlow, no inbound ports | **Recommended for direct import** |
| C. `TALLY_HTTP_URL` from the ManuFlow server | Only if ManuFlow is self-hosted on the same LAN | Not for the current cloud setup |
| D. Port-forward / tunnel Tally's port to the internet | Exposes unauthenticated books | **Rejected** |
| E. Browser talks to Tally directly | Blocked by browsers | Not possible |

**Connector needed?** Yes, for direct import with the current cloud deployment (option B). Not needed for file import (A).

## Safe to import (in order)
1. Masters: ledgers under Sundry Debtors → customers, Sundry Creditors → suppliers (party in both → "Both"),
   stock items → items (unit mapped explicitly, HSN, GST rate).
2. Godown-wise closing stock at the go-live date → opening stock (existing service, go-live lock).
3. Party opening balances — **blocked** until the opening-balance model is decided (`docs/opening-balances.md`).
4. Vouchers (sales, purchases, receipts, journals) — **not safe yet**: no general ledger, document numbering and
   bill-wise outstanding decisions are open.

## Requirements
- **Mapping:** Tally group → party kind; GST registration type, state code, GSTIN, PAN; Tally units → ManuFlow UOM
  (explicit table, unmapped = error); HSN / GST rate (latest applicable); godown → warehouse (explicit choice).
- **Duplicates:** stable key = Tally GUID (or company + master id) stored per record — needs a small additive schema
  change (e.g. an external-reference table); fallback match by GSTIN, then exact name; re-sync updates only mapped
  fields and never merges silently.
- **Validation:** reuse the existing import services and dry-run preview; nothing is saved without the user's confirm.
- **Security:** per-company pairing token (shown once, stored hashed, expiring, revocable); connector is outbound-only,
  talks to `127.0.0.1` Tally only; server sends job names, never raw XML or URLs; XML parsed without DTD / entities,
  size and time limits; tenant bound to the token; audit of pairing, jobs and imports; admin-only (Import Center).
- **Reconciliation:** counts per Tally group vs imported; closing stock quantity / value per godown vs ManuFlow at the
  go-live date; later, trial balance at go-live vs ManuFlow opening figures. Mismatches block "done".

## Proposed plan (each step needs approval)
| Step | Scope | Needs |
|---|---|---|
| T1 | Capture anonymised replies from real TallyPrime (trial / education is enough) for company list, ledgers, stock items, closing stock — at least 2 releases; store as test fixtures | A Tally machine (user) |
| T2 | XML → row mappers + tests against the fixtures, feeding the existing preview; no connector yet | T1 |
| T3 | Schema: connector token + external reference (additive), pairing UI, connector API (job queue, upload) | Schema approval, deploy plan |
| T4 | Windows connector (tray app / service), signed, outbound only; install guide incl. firewall | Code-signing decision |
| T5 | Masters import end to end + reconciliation report; then closing stock | T2–T4 |
| T6 | Party opening balances, then vouchers — only after the accounting decisions | Separate decisions |

## Unresolved questions (for the user)
1. TallyPrime release(s) and edition in use; one or several companies; single PC or multi-user / remote (TSS / Tally on cloud)?
2. Is a test machine with TallyPrime (and anonymised data) available for T1?
3. Will ManuFlow stay cloud-only, or is a self-hosted / LAN install planned?
4. Go-live date and which data first (masters only, or also closing stock)?
5. Who installs the connector on the Windows PC; is code signing / an installer required?

## Risks / blockers
- Unauthenticated Tally port — any design that exposes it beyond `127.0.0.1` is unsafe.
- Reply formats unverified → T1 blocks all mapping work.
- Additive schema change needed (T3) → follows the staging + backup + approval deploy gate.
- CB-R1 (connection-pool timeouts under bursts of new documents) can affect bulk imports that number documents.
- Large uncommitted work on the branch (Import Center English UI, Cash & Bank Phases 0–2) — committing it before new
  work starts is recommended (needs approval).

---

# Accounting completion audit (2026-10-25)

Audit only — no application code changed, no production access, no schema change, no deploy. Evidence = code
inspection, the existing test suite (190/190 pass, run 2026-10-25), and a one-off consistency probe on the throwaway
test database (fresh company, no opening balances; capital, purchase + stock, two sales, expense, loan + EMI, contra,
drawings, sales and purchase return, a post-dated cheque). The probe file was deleted after the run.

Status key: **DONE** = implemented and covered by tests · **PARTIAL** = implemented with a gap, bug or no test ·
**NOT STARTED** · **BLOCKED**.

## Requirements

| ID | Requirement | Status | Evidence | Gap |
|---|---|---|---|---|
| AC-01 | Sales invoices (GST, cash sale, "received now", edit, cancel) | PARTIAL | `sales-invoices/*`; used in cash-bank tests; probe | No dedicated tests for GST split, inter-state, round-off, edit/cancel with stock |
| AC-02 | Purchase bills (GST, stock receive, "paid now", edit, cancel) | PARTIAL | `purchase-invoices/*`; cash-bank tests; probe | Same as AC-01 |
| AC-03 | Sales / purchase returns (credit / debit notes) | PARTIAL | `sales-returns`, `purchase-returns`; cash-bank tests; `sales-return-cost.test.ts` | AC-B1 fixed locally; refunds (CB-R8); raw dates (AC-B3) |
| AC-04 | Receipts (Payment In) incl. cheques / PDC | DONE | `payments/*`; Phase 0–2 tests | Advances without invoice — Phase 4 |
| AC-05 | Payments Out incl. cheques / PDC | DONE | same | same |
| AC-06 | Expenses (POSTED only, account, opening date) | DONE | `expenses/*`; Phase 1 tests | Hard delete (audit-logged) |
| AC-07 | Journal vouchers | NOT STARTED | no model, route or UI (`grep journal` → none) | Needs a design (chart of accounts) and a schema change |
| AC-08 | Contra (cash ↔ bank ↔ bank) | DONE | `account-txns`; Phase 0–2 tests | — |
| AC-09 | Loans / EMI (principal + interest, fee) | DONE | `loans/*`; tests; probe (interest and fee in P&L) | — |
| AC-10 | Ledgers | PARTIAL | Cash/bank statement + history (tested); customer statement `customers/[id]/statement` (tested, Phase 4); supplier statement `suppliers/[id]/statement` (used by Payables; fixed + tested, Phase 5); party summary `parties/[kind]/[id]` (there is no `parties/…/statement` route — an earlier version of this row said there was) | No general ledger per account head (needs AC-07) |
| AC-11 | Trial balance | PARTIAL | `trialBalanceFrom` — probe: difference 0 | Built from derived positions, not double entry; no automated test |
| AC-12 | Profit & Loss | PARTIAL | `profitAndLoss`; `accounting-reports.test.ts` (COGS / gross / net after returns) | Closing stock at current average; legacy returns before the fix stay in history |
| AC-13 | Balance sheet | PARTIAL | `balanceSheetFrom` — probe: balancing plug 0 | Always balances by construction ("Opening balance difference" plug hides errors); no test asserting plug = 0 |
| AC-14 | Cash flow | DONE | `cashFlow`; Phase 1–2 tests (`difference` 0) | — |
| AC-15 | Daybook / transactions report | DONE | `listTransactions`; Phase 2 tests (CB-R4) | — |
| AC-16 | Cash & Bank accounts, balances, history | DONE | Phases 0–2 (190 tests) | CB-R2, R5, R7, R9 open |
| AC-17 | GST returns (GSTR-1 JSON, 2, 3B, 9) | PARTIAL (not verified) | routes exist under `reports/` | No tests; not reviewed in this audit |

## Bugs and risks

| ID | Finding | Severity | Evidence |
|---|---|---|---|
| AC-B1 | **FIXED locally (2026-10-25, see below).** Was: sales return put goods back into stock at the selling price, not cost (`sales-returns/route.ts:156`, `rate = taxable / qty`) → average cost, closing stock and gross profit overstated | High | Probe: 3 units bought at ₹100 show ₹375 instead of ₹300; COGS ₹525 instead of ₹600 |
| AC-B2 | Party opening balances (`Customer/Supplier.openingBalance`) have no date — counted in every historical receivable / payable, absorbed by the balance-sheet plug | Medium | `partyOutstanding` sums them without `asOf` |
| AC-B3 | Raw `new Date(body.date)` / "now" on other dated documents: sales and purchase returns (GST, P&L), GRNs and deliveries (stock), quotations / enquiries | Medium (returns, GRN, delivery) | grep of routes; CB-R3 covered only invoices and bills |
| AC-B4 | Balance-sheet plug masks inconsistencies; nothing alerts when it is non-zero | Medium | `balanceSheetFrom` |
| CB-R1 | Document numbering uses a second pool connection inside transactions → P2024 under bursts | Medium | Phase 1 finding, unchanged |
| CB-R5 | Payment mode vs account type | Resolved locally (Phase 3) | server rule in `postingAccount`, tests |
| CB-R6 / CB-R10 | Production: 1 account without opening date; 1 legacy payment without `accountId` | Low (data) | Phase 0 counts; need approval |
| — | PDC dates, IST dates for money documents, opening-date rules, DRAFT expenses | Resolved locally | Phases 1–2, tested |

## Test results (2026-10-25)
| Check | Result |
|---|---|
| Full suite | PASS 190/190 |
| App TypeScript | PASS (4 pre-existing errors in `examples/`, `mini-services/`) |
| Test TypeScript | PASS |
| Consistency probe (one-off) | PASS on plug / TB / cash flow / P&L = retained; FAIL on stock valuation (AC-B1) |

Note: the throwaway test MySQL had been wiped with the session scratchpad and was recreated (test-only, local).

## Report-consistency regression test (2026-10-25) — done, test-only
File: `tests/accounting-reports.test.ts` (no app code changed). Deterministic: fixed system time (1 Jun 2026),
throwaway test database, synthetic data, no external services.

| Test | Kind | Result |
|---|---|---|
| balance-sheet plug is 0, trial balance and cash flow have no difference, P&L equals retained profit | regression | PASS |
| hand-checked positions: cash, bank, receivable, payable, GST, loans, cheques in hand, capital, drawings | regression | PASS |
| P&L lines unaffected by AC-B1: sales, purchases, expenses, loan interest and fee | regression | PASS |
| KNOWN DEFECT AC-B1 — current behaviour, NOT correct accounting: minimal case (stock ₹999.99, COGS ₹0.01, gross ₹199.99) | pins the bug | PASS |
| KNOWN DEFECT AC-B1 — current behaviour, NOT correct accounting: full scenario (stock ₹375, COGS ₹525, gross ₹675, net −₹1125) | pins the bug | PASS |
| EXPECTED CORRECT (AC-B1 spec): minimal case (stock ₹900, COGS ₹100, gross ₹100) | `test.failing` | PASS (fails as expected) |
| EXPECTED CORRECT (AC-B1 spec): full scenario (stock ₹300, COGS ₹600, gross ₹600, net −₹1200, plug 0) | `test.failing` | PASS (fails as expected) |

- Checked by temporarily running the two spec tests as normal tests: both reach the end of setup and fail only on the
  AC-B1 figure assertions (lines 181 and 188); the file was restored afterwards.
- When AC-B1 is fixed the spec tests start "failing" in bun: remove `.failing` there and delete the two KNOWN DEFECT tests.
- Results: new file 7/7 pass; full suite **197/197** across 20 files; test TypeScript 0 errors; ESLint 0.
- AC-11 / AC-13 now have an automated consistency test (still PARTIAL: AC-B1 and the plug design remain).

## AC-B1 fix — first attempt STOPPED (2026-10-25): original cost is not recorded (resolved below)
Approved scope was "restore returned goods at the original cost recorded in that sale's stock records". Tracing shows
that cost does not exist in the records, so — as instructed — no fallback was invented and no app code was changed.

Verified facts:
- Costing is **weighted average per item + warehouse** (`postStock`, `src/lib/erp-helpers.ts`): `StockBalance.avgRate`
  changes only on stock-in rows with a rate; outward rows do not change it.
- The sale's outward stock rows store the **selling price**, not cost: direct invoice `SALE_OUT` uses `rate: l.rate`
  (`sales-invoices/shared.ts` `postSaleStock`); challan `DISPATCH_OUT` uses the SO rate or the item's selling price
  (`deliveries/[id]/route.ts:116`). Cost at the moment of sale is not stored anywhere.
- Batches (`ItemBatch`) carry no cost. Reports value stock as quantity × current `avgRate`.
- Invoice cancel already re-enters stock at the **current** average (`SALE_CANCEL_IN`, `rate = avgRate`).
- Related gap found: a return against an invoice that never moved stock (direct invoice with "deduct stock" off) still
  adds stock — goods that never left are counted in again (inventory double count).
- Outward `rate` is shown by the stock ledger / item-detail screens, so re-using it to hold cost would change what
  those screens show.

Decision needed (business):
| Option | What the return uses | Schema | Notes |
|---|---|---|---|
| A | Weighted-average cost **at the moment of the original sale**, rebuilt by replaying that item + warehouse's ledger up to the sale's outward row | none | Closest to "original cost"; deterministic; depends on ledger order; legacy wrong returns are replayed as they were |
| B | **Current** weighted-average cost of the return warehouse at the return date | none | Same rule as invoice cancel; simple; not the original cost |
| C | Store unit cost on outward rows from now on (new column); returns use it; older sales fall back to A or B | **additive schema change** | Cleanest long term; needs schema approval and the deploy gate |
Also needed: what to do when the invoice moved no stock (refuse stock-in and post the credit note only, or require an
explicit warehouse and cost), and which warehouse's cost applies when goods return to a different warehouse.

The AC-B1 tests stay as they are (KNOWN DEFECT tests pass; EXPECTED CORRECT tests are `test.failing`). All three
options give the same figures in those two scenarios (one purchase cost of ₹100), so extra tests for multiple costs and
partial returns will be written once the option is chosen.

## Next recommended phase — "Accounting A1: report correctness"
1. ~~Add a permanent report-consistency test~~ — done (`tests/accounting-reports.test.ts`).
2. ~~Fix AC-B1~~ — done locally (see "AC-B1 fix — implemented locally").
   **Next:** step 3 below.
3. Extend `businessDate()` to returns, GRNs and deliveries (AC-B3).
4. Decide AC-B2 (party opening-balance date = go-live date) together with the opening-balance model.
Journal vouchers / general ledger (AC-07, AC-10) need a design and a schema change — a separate, later phase.

## AC-B1 fix — implemented locally (2026-10-25; Option C for new sales, Option A for legacy)
Not committed, not deployed; production untouched. Schema change applied only to the guarded local test database.

**Schema migration (additive):** `StockLedger.costRate Float?` — on outward rows, the weighted-average cost per unit
at the moment the goods left. Nullable, no default, no index; existing rows stay null. `rate` keeps its meaning
(selling price on sale rows), so stock-ledger / item-detail screens are unchanged. Production will get it through the
normal deploy (`prisma db push`, no data-loss flag) only after staging + verified backup + approval.

**Behaviour:**
- `postStock` (`src/lib/erp-helpers.ts`) stores `costRate` = average before the movement on every outward row
  (sales, challan dispatch, issues, adjustments, returns to supplier…); stock-in rows keep it null.
- `src/lib/sale-cost.ts` (new):
  - `saleStockMode`: DIRECT (invoice moved stock), CHALLAN (its challan did) or NONE.
  - `liveSaleRows`: the sale's outward rows still standing (direct: SALE_OUT net of SALE_CANCEL_IN after edits).
  - `originalUnitCost`: qty-weighted stored cost.
  - `reconstructOutCost`: older rows — replays the item + warehouse ledger with postStock's formula and is trusted
    only if the full replay equals today's StockBalance; otherwise 409 "needs review".
- Sales return (`sales-returns/route.ts`): goods re-enter at the original unit cost into the chosen warehouse (even if
  sold from another — physical stock where it is, value at the sale's cost). Invoice that moved no stock → credit
  note only, no stock-in (`stockReturned: false`, audit note). Sales-order invoice without its challan while that
  order's goods left on challans → 409 review. Review stops happen before anything is written.
- Return cancel (`sales-returns/[id]/route.ts`): takes out exactly what the return received, at the cost it came in at
  (previously took out every line, even when nothing came in).
- Invoice cancel / edit (`sales-invoices/shared.ts` `reverseSaleStock`): back in at the stored original cost; sales
  recorded before `costRate` keep the previous rule (current average) — unchanged behaviour for legacy rows.
- Challans have no cancel path; dispatch rows now carry `costRate`.

**Tests:**
- `tests/accounting-reports.test.ts`: the two KNOWN DEFECT tests were removed; the two specs are normal tests —
  "AC-B1: minimal case" (stock ₹900, COGS ₹100, gross ₹100) and "AC-B1: full scenario" (stock ₹300, COGS ₹600,
  gross ₹600, net −₹1200, balance-sheet plug 0). 5/5 PASS.
- `tests/sales-return-cost.test.ts` (new, 14) — all PASS: cost stored on the sale row; weighted average at the
  moment of sale (₹150, not today's ₹210 or the ₹500 price); partial returns; over-return refused (sequential and
  concurrent); invoice edit reversed at the original cost and later return at the re-posted cost; invoice cancel at
  the original cost; two lines of one item; legacy reliable history (rebuilt ₹150); legacy history not matching the
  balance → 409, nothing saved; legacy history with a missing movement → 409; stock deduction off → credit note only,
  cancel moves no stock; return to another warehouse (and its cancel); challan invoice uses the dispatch cost;
  sales-order invoice without its challan → 409.
- Full suite **209/209 PASS** (21 files); app TypeScript PASS (only the 4 pre-existing errors in `examples/`,
  `mini-services/`); test TypeScript 0 errors; ESLint 0 on changed files; production build PASS.

**Compatibility risks / open accounting decisions:**
1. Deploy must regenerate the Prisma client and add the column before the new code runs (staging will prove it).
2. Legacy returns (before the fix) stay in history at the selling price; they keep influencing average cost — no
   backfill planned (would need approval).
3. Legacy rebuild depends on ledger order (createdAt, then id) and on StockBalance only ever changing through
   postStock; anything else (e.g. a restored backup with edited balances) makes returns stop for review.
4. A recorded average of ₹0 (stock received without a rate) is used as the cost — goods return at ₹0.
5. Sales-order invoices billed without their challan cannot be returned into stock until reviewed; decide whether
   such invoices should be blocked or linked to a challan.
6. Return dates are still raw timestamps (AC-B3). Closing stock is still valued at the current average (by design).
7. Invoice cancel for legacy sales still uses the current average (unchanged).

## Cash & Bank Phase 3 — Vyapar-style actions (2026-10-25) — done locally
Not committed, not deployed; no schema change, no new routes; production untouched.

**Decisions applied (user, 2026-10-25):** CASH → a cash account; UPI / NEFT / RTGS / CHEQUE / BANK → a bank account;
no fallback to cash (refused with "add a bank account"); validated on the server; legacy records keep their account
when mode and account are unchanged. Adjust Cash: excess → Other income, shortage → Other expense, zero → nothing.
The Add / Reduce money "Other" category is unchanged (risk below).

**Changes:**
- `src/lib/erp-constants.ts`: `accountTypeForMode` (shared UI + server) and `accountsForMode` (accounts of the mode's
  type + the default the server will use — same order as `postingAccount`).
- `src/lib/accounts.ts` `postingAccount` / `ensureCashFor`: a chosen account must match the mode (400 with a clear
  message); no chosen account → the mode's default account, refused when the company has none (no cash fallback, and
  no "Cash in Hand" is created for a bank-mode attempt). `keepExistingId` lets an existing record keep its account.
  Every payment / expense / invoice "received now" / bill "paid now" path goes through it.
- `src/app/api/expenses/[id]/route.ts`: an edited expense keeps its (even mismatched) account while mode and account
  are unchanged; an expense saved without an account stays without one while its mode is unchanged; a mode change
  alone moves it to the new type's default (only when the mode really changes).
- `src/components/erp/modules/cash-bank.tsx`: header **Money In · Money Out · Transfer · Adjust Cash · Bank Account**.
  Money In → "From a customer" (Payment In form) / "Capital or other income" (Add money). Money Out → "To a supplier"
  (Payment Out) / "Expense" (Expense form) / "Drawings or other" (Reduce money). **Adjust Cash**: cash account (default
  pre-selected, also when the list loads late), date, books balance on that date (statement API), counted amount,
  difference preview → Review → Confirm; the balance is re-read before saving and a changed balance is shown again.
- `src/components/erp/modules/payments.tsx`: invoice / bill required (the "Advance / on account" option the server
  always rejected is removed; advances are Phase 4), outstanding shown, amount checked against it, accounts filtered
  by mode, "Will be recorded in …" / "No bank account — add one…" hint.
- `src/components/erp/modules/expenses.tsx`: opens from Cash & Bank (`useCreatePreset('expenses')`), accounts filtered by
  mode with the same hint, an edited expense's current account stays selectable.
- `sales-invoices.tsx`, `purchase-invoices.tsx`: "Into / From account" filtered by mode, warning when the type has no account.

**Tests (actual results):**
| Check | Result |
|---|---|
| `tests/cash-bank-phase3.test.ts` (13): matching pairs on 4 routes; mismatches refused (nothing saved); no bank → every bank mode refused on 4 routes, no account created; cash still creates Cash in Hand; default account = UI helper; legacy mismatched expense kept / new mismatch refused; legacy no-account expense stays without one; mode change alone; Adjust Cash excess / shortage (cash, P&L, plug unchanged, TB unchanged, cash-flow 0) / zero; KNOWN RISK "Other"; KNOWN GAP AC-B5 | PASS 13/13 |
| Full suite | PASS 222/222 (22 files) — no existing test relied on the cash fallback |
| App TypeScript | PASS (4 pre-existing errors in `examples/`, `mini-services/`) |
| Test TypeScript | PASS (0 after fixing 3 typing errors in the new test) |
| ESLint (changed files, incl. `react-hooks/refs`) | PASS 0 |
| Production build (deploy file set) | PASS |
| Browser (local build, throwaway seeded DB, headless Chrome) | PASS 19/19 — header buttons; Money In / Money Out choosers open the payment and expense forms; payment form without the advance option, invoice-required message, "no bank account" hint, cash-only accounts for CASH, "Will be recorded in"; expense hint; Adjust Cash books balance, excess preview, review → confirm, saved as Other income; zero difference saves nothing; no horizontal scroll at 390 px; no page errors |

Found and fixed during verification: Adjust Cash opened before the account list loaded had no cash account selected
(fixed by deriving the default); an expense edit re-sending the same mode re-assigned a legacy expense's account
(fixed: only a real mode change does).

**Remaining risks:**
1. **"Other" category (kept by decision):** Add / Reduce money with category "Other" is neither income nor capital and
   lands in the balance-sheet balancing figure (test "KNOWN RISK … Other"). Historical entries untouched. Phase 5.
2. **AC-B5 (new finding, pre-existing):** the trial balance has no line for money-account opening balances, so its
   difference equals those openings (test "KNOWN GAP AC-B5"); the balance sheet absorbs them in its balancing line.
   Needs an opening-balance equity line — separate decision.
3. API callers that used to post UPI / NEFT into a cash account, or relied on the cash fallback without a bank account,
   now get 400 — intended (CB-R5); old records stay as they are.
4. Legacy rows without an account are still *reported* on the default cash / bank account (reporting rule only).
5. The payment form requires an invoice until advances arrive (Phase 4).

## Cash & Bank Phase 4 — customer advances and return refunds (2026-10-26) — done locally
Not committed, not deployed; production untouched. Stopped after Phase 4 (Phases 5–6 not started).

**Decisions applied (user, 2026-10-26):** schema option B; customer advances only (supplier advances out of scope);
no post-dated cheques as advances; a sales-return credit may be refunded or applied to another invoice of the same
customer and is never counted as an advance; purchase-return refunds; **GST on advances for services is out of scope —
nothing in Phase 4 computes GST on advances (goods advances carry none under current rules; service advances would need
it)**; fix the customer statement counting bounced cheques.

**Schema (additive, local test database only):** `Payment.allocatedFromId String?` + `@@index([allocatedFromId])` — on an
application row, the source: the advance payment (mode `ADVANCE_ADJ`) or the sales return whose credit is applied to
another invoice (mode `CREDIT_NOTE`). Same plain-id style as the other Payment links (no Prisma relations). The project
uses `prisma db push` (no migration files); production gets it only through the Phase 6 gate.

**Accounting treatment (as implemented):**
| Event | Payment row | Effect |
|---|---|---|
| Advance received | RECEIPT, `invoiceType 'ADVANCE'`, no invoice | Cash/Bank ↑, **Customer advances** (liability) ↑; no sales, receivable unchanged |
| Advance applied | `ADVANCE_ADJ`, invoice, `allocatedFromId` = advance | no cash; invoice paid ↑ (receivable ↓), Customer advances ↓ |
| Return credit beyond its invoice | (from the note; part applied to its own invoice stays a CREDIT_NOTE row) | **Refunds due to customers** (liability) |
| Return credit applied elsewhere | `CREDIT_NOTE`, other invoice, `allocatedFromId` = return | no cash; receivable ↓, refunds due ↓; not an advance |
| Refund to customer | PAYMENT, `invoiceType 'SALES_RETURN'`, invoice = return | Cash/Bank ↓, refunds due ↓; no expense |
| Refund from supplier | RECEIPT, `invoiceType 'PURCHASE_RETURN'`, invoice = return | Cash/Bank ↑, **Refunds due from suppliers** (asset) ↓; no income |
P&L is untouched by advances, applications and refunds (returns already reduce sales / purchases). `ADVANCE_ADJ` is a
no-cash mode everywhere (balances, history, cash flow, daybook). Return stock / cost logic unchanged.

**Changes:**
- `src/lib/party-credits.ts` (new): remaining advance, remaining return credit / refund, and the three balance-sheet
  figures as of a date (bounced cheques never count).
- `src/lib/credit-apply.ts` (new): one locked application path for both sources — source row locked, remaining
  recomputed, invoice incremented under its row lock, refused beyond either balance, other customer, date before
  the source or the invoice.
- `payments/route.ts`: advances (`ADVANCE`) and refunds (`SALES_RETURN` / `PURCHASE_RETURN`) — return row locked, amount
  ≤ remaining; list shows kind / applied / remaining / source / return number.
- `payments/[id]/route.ts`: `action: 'apply'`; void removes an application (both balances restored); an applied advance
  can't be voided or bounced; refunds void / bounce without touching invoices; invoice-table choice guarded.
- `sales-returns/[id]`: `action: 'apply'`; cancel refused while refunds or applications exist (own-invoice credit rows
  only are removed on cancel). `purchase-returns/[id]`: cancel refused while refunds exist. Return lists show the
  credit / refund breakdown.
- `src/lib/accounting.ts`: position / balance sheet / trial balance lines for Customer advances, Refunds due to
  customers, Refunds due from suppliers.
- `customers/[id]/statement`: bounced cheques excluded (pre-existing bug fixed), refunds as debits, credit-note excess as
  a credit, applications not repeated; opening balance from the same rows.
- `parties/[kind]/[id]`: customer received excludes bounced / applications / refunds, adds refunded, advance and credit
  balances, net balance; supplier paid excludes refunds received, adds refund received / due.
- UI: Payment In "Advance (no invoice yet)" (kept when the party changes); payment list Advance · ₹x left / Apply /
  Remove; Sales Returns "Credit left" + Refund + Apply; Purchase Returns "Refund due" + Record refund
  (`src/components/erp/refund-dialog.tsx`, accounts filtered by mode); Cash & Bank Money In "Advance from a customer" /
  "Refund from a supplier", Money Out "Refund to a customer"; receivables statement row types.

**Tests (actual results):**
| Check | Result |
|---|---|
| `tests/cash-bank-phase4.test.ts` (16) — company without opening balances, so every test asserts balancing figure 0, TB difference 0, cash-flow difference 0: advance receipt; refused cases (PDC, invoice, supplier, unknown); partial / multi-invoice application; over-application (advance, invoice, other customer, date); concurrent applications; removal; applied advance void / bounce blocked then allowed; full + partial customer refunds and excess; concurrent refunds + wrong customer; return credit applied elsewhere (+ removal); return cancel blocked → void → cancel; supplier refunds full / partial / excess / concurrent; purchase-return cancel blocked → void → cancel; customer statement (bounced excluded, refund debit, note credit, closing ₹160 = ledger net); supplier summary; Cash & Bank history | PASS 16/16 (3 consecutive runs) |
| Full suite | PASS 238/238 (23 files) |
| App TypeScript | PASS (4 pre-existing errors in `examples/`, `mini-services/`) |
| Test TypeScript | PASS 0 (2 typing errors in the new test fixed) |
| ESLint, all changed / new files | PASS 0 errors (1 pre-existing warning, `purchase-invoices/[id]/route.ts:97`) |
| Production build (deploy file set, fresh Prisma client) | PASS |
| Browser (local build, freshly seeded throwaway DB) | PASS 18/18 — choosers; advance via Payment In; list "₹700 left"; Apply → "₹250 left" + application row + invoice paid ₹450; Remove → "₹700 left"; Sales Returns credit left / Refund → ₹80 left; Purchase Returns Record refund → nothing due; balance sheet shows advances ₹700, refunds due ₹80, supplier refunds gone; 390 px; no page errors |

Found and fixed during verification: refund popup / payment form refused "add a cash account" when submitted before the
account list loaded (now only checked after it loads — the server applies the rule anyway); choosing the party after
"Advance" cleared the advance choice (kept now).

**Remaining risks:**
1. GST on service advances not handled (out of scope by decision).
2. Supplier advances not supported (out of scope).
3. ~~No full supplier statement screen (summary only)~~ — **this was wrong** (corrected 2026-10-27): the supplier
   statement route `/api/suppliers/[id]/statement` exists and the Payables screen prints it; it still had the bugs
   fixed in Phase 5 (bounced cheques, refund sign, debit-note excess). Customer and supplier statements and summaries depend on these rules — any new
   payment kind must follow `party-credits.ts`.
4. Application rows show "In" in the payment list type column although no money moves (mode "Advance applied" /
   account "—" make it clear) — cosmetic.
5. Forms default "today" from the browser's UTC date (pre-existing, app-wide): between 00:00 and 05:30 IST the default
   date is the previous day.
6. Historical returns: their excess now appears as "Refunds due to customers" / "from suppliers" instead of inside the
   balancing figure (production had 0 returns at the Phase 0 count).
7. CB-R1 (numbering pool timeouts) still applies to bursts of new documents, including applications (`ADJ` numbers).

## Production deploy (2026-10-26 ~01:17 IST) — on the user's explicit "deploy kar"
- Gate: local suite 238/238 → `deploy.py --check` (live 200) → `--stage` (server TypeScript + ESLint 0 errors, 8 pre-existing
  warnings, build OK) → deploy.
- Verified DB backup: `~/backups/predeploy/20261026-011654.sql.gz` (complete). Previous release:
  `~/backups/releases/next-20261026-011654` (`python deploy.py --rollback`).
- Schema: `prisma db push` without the data-loss flag — "in sync", adding `StockLedger.costRate` and
  `Payment.allocatedFromId` (+ index), both nullable; existing rows untouched.
- Health: local 200, `/api/auth/me` 401 (expected), public 200; live bundles contain the Phase 3/4 and English Import texts.
- Not done: no signed-in smoke test on production (no production credentials used); Phase 1b backfill not run.
- Behaviour now live that users may notice: UPI / NEFT / RTGS / cheque payments need a bank account (no fallback to cash);
  money dated before an account's opening date is refused; the payment form needs an invoice or "Advance".

## Cash & Bank Phase 5 (2026-10-26 → 2026-10-27) — done locally, NOT deployed
Approved 2026-10-26 16:50 IST "locally only". Not committed, not deployed, production not accessed. The only schema
change (`IdempotencyKey`) was pushed only to the local throwaway test databases (`manuflow_test`, `manuflow_dev`).
Phase 1b backfill: **not approved, not done**. Phase 6: **not started**.

**Decisions applied:** financial reports Option A; negative cash blocked on CASH accounts only, override only for
TENANT_ADMIN / SUPER_ADMIN (every other role, incl. MANAGEMENT and ACCOUNTANT, gets 403 when it asks), override
audit-logged; duplicate = same party / account, amount, mode on the same IST day, confirmable; hard idempotency in a
dedicated table; read permissions from existing module keys only (no new keys, nothing granted); payment-kind
permissions; supplier statement fix.

**What changed:**
- **CB-R1** `src/lib/erp-helpers.ts`: `docPrefix()` reads through the transaction; the first counter of a
  (company, type, FY) is created under a `Company … FOR UPDATE` lock with a locking re-check (no second pool
  connection, no insert deadlock). All 28 `nextDocNumber` callers pass their transaction.
- **Read permissions (CB-R7)** `requireRead` / `requireFinancialReports` (`erp-helpers.ts`), `canSeeFinancialReports`
  + `FINANCIAL_REPORTS` (`erp-constants.ts`):
  - Cash & Bank (`accounts/**` statement and detail, `account-txns`, `loans/**`, `cash-bank/transactions`) → `cash-bank`.
    `GET /api/accounts` list: full list (balances, opening figures) needs `cash-bank`; roles that record money elsewhere
    (`payments`, `expenses`, sales / purchase invoices / returns) get the **account picker only** (id, name, type,
    active, isDefault) — needed by their forms; no balances.
  - `payments/**` → `payments`; `expenses` → `expenses`; `sales-returns/**`, `purchase-returns/**` → their module.
  - `sales-invoices/**` GET → `sales-invoices` | `receivables` | `gst-report`; `purchase-invoices/**` GET →
    `purchase-invoices` | `payables` | `gst-report` (these GETs had no check at all before).
  - Customer statement → `receivables` | `customers`; supplier statement → `payables` | `suppliers`.
  - Reports: P&L, balance sheet, trial balance, cash flow, daybook, transactions, profitability → Option A
    (`reports` + one of `sales-invoices`, `purchase-invoices`, `cash-bank`); stock valuation, item detail, sales by
    customer, purchase by supplier → `reports`; GSTR-1 JSON / 2 / 3B / 9 → `gst-report`.
  - Dashboard money tiles: receivables / payables / cash / bank figures omitted for roles without the module (the
    UI already hid the tiles).
  - UI: Reports Center hides the financial cards per Option A; the Payments screen loads and offers only the side
    (Payment In / Payment Out) the role may use.
- **Payment-kind permissions** `paymentKindModule` (`party-credits.ts`): on top of `payments`, customer receipts /
  advances / advance applications need `sales-invoices`; customer refunds and return-credit applications need
  `sales-returns`; supplier payments need `purchase-invoices`; supplier refunds need `purchase-returns` — on create,
  apply, void, deposit / clear / bounce.
- **Negative cash (CB-R9)** `src/lib/cash-guard.ts`: last step of the business transaction — locks the cash account
  rows (`FOR UPDATE`, id order), then computes the lowest **end-of-day** balance from the entry's day onward (so a
  back-dated entry is refused if any later day goes negative; money received the same day covers a payment). The
  transaction runs at READ COMMITTED (`CASH_TX`) so the reads after the lock see every earlier committed entry
  (proved: with the default REPEATABLE READ both concurrency tests fail). 409 `NEGATIVE_CASH` with
  `{ accountId, accountName, date, balance, shortfall }`. Checked: Payment Out, customer refund, bill "paid now",
  expense create / edit (more money, earlier date, other account / mode, DRAFT→POSTED), Reduce cash, contra out of
  cash, loan EMI, and removals of money that came in — voiding a cash receipt / advance / supplier refund, bouncing a
  counted cheque received (only matters for a cash account), deleting Add-cash / transfer-in entries, editing
  (less money, later date, other account) or deleting a loan, lowering a cash account's opening balance. Bank
  accounts are never checked. Override `allowNegativeCash: true`: TENANT_ADMIN / SUPER_ADMIN only (403
  `NEGATIVE_CASH_OVERRIDE_DENIED` for everyone else, nothing saved); the audit row (`NEGATIVE_CASH_OVERRIDE`) names
  the account, day, balance, shortfall and the user and role from the verified session headers.
- **Adjust Cash**: the screen sends `expectedBalance` (the balance the user reviewed); the server refuses with 409
  `BALANCE_CHANGED` (+ current balance) if the books moved meanwhile; the screen shows the new difference to review.
- **Duplicates**: payments (same direction, party, amount, mode, IST day), expenses (account, paid to, amount, mode,
  day; cancelled ones ignored), Cash & Bank entries (type, accounts, amount, day; not for an Adjust Cash with
  `expectedBalance`) → 409 `POSSIBLE_DUPLICATE` `{ matches: [numbers] }` unless `confirmDuplicate: true`. The
  confirmation skips only this check (negative cash, permissions, validation still apply — tested).
- **Idempotency** `prisma/schema.prisma` model `IdempotencyKey` (unique companyId + key), `src/lib/idempotency.ts`:
  the key is claimed (PENDING, own commit) before the business transaction; `done()` marks it DONE with the response
  inside the business transaction (atomic with the documents); a repeat with the same body replays the stored
  response (`Idempotent-Replay: true`); still running → 409 `IDEMPOTENCY_IN_PROGRESS`; other body / route / user →
  422 `IDEMPOTENCY_KEY_REUSED`; a failed request deletes its claim (retry runs normally); a claim left by a dead
  process is taken over after 10 minutes (DB clock) and the old claim can no longer commit; keys purged after 7
  days. No header → unchanged behaviour. Covered: payment create (incl. advances / refunds), advance apply, return
  credit apply, expense create, Cash & Bank entry / transfer create, loan create, EMI, sales invoice create (received
  now), purchase bill create (paid now).
- **Client** `src/lib/use-api.ts`, `src/components/erp/money-confirm-dialog.tsx` (mounted in `erp-app.tsx`): those
  requests get an `Idempotency-Key`; a lost answer (network error) or "in progress" is retried with the same key
  (3×, backoff); if the outcome is still unknown the key is kept for that exact request for 10 minutes, so saving the
  same entry again cannot record it twice; identical requests in flight are sent once. `POSSIBLE_DUPLICATE` → dialog
  "Possible duplicate" (Save anyway / Cancel); `NEGATIVE_CASH` → dialog with the admin override for Tenant Admin /
  Super Admin, otherwise the message plus "Only a Tenant Admin can save it anyway." The form behind keeps its values
  and stays busy until answered; Cancel → "Not saved: you cancelled."
- **Supplier statement** `src/app/api/suppliers/[id]/statement/route.ts` (mirrors the Phase 4 customer fix):
  bounced cheques excluded; refunds received from the supplier are debits; the part of a debit note above its bill's
  balance is a credit row; debit notes adjusted on their bill shown as such; cancelled debit notes drop out. Closing =
  open bills − refunds still due from the supplier (+ master opening), reconciled in tests with
  `partyCreditsAsOf`. Company-scoped; another company's supplier → 404.

**Verification (actual results, 2026-10-27, guarded test DB `manuflow_test` on a throwaway local MySQL):**
| Check | Result |
|---|---|
| `tests/cash-bank-phase5.test.ts` (42): CB-R1 (burst of 10 first numbers, two FYs + custom prefix, rollback); role × endpoint read matrix (12 roles × 18 reads); Option A rule; account picker without balances; statement isolation; dashboard; payment kind × role create / apply / void / bounce (nothing saved on refusal); negative cash (shortfall details, same-day cover, back-dated later-day check, bank overdraft allowed, override roles + audit actor, removals, all outflow routes, expense edits, 5 concurrent outflows → exactly 3, void/payment race, Adjust Cash stale balance); duplicates (payments, advances, expenses, entries; confirmation bypasses nothing else); idempotency (replay, 8 concurrent same key → 1 payment, cross-route, 422 cases, failed request frees key, crash atomicity, stale takeover, all keyed routes, company isolation, purge, no header); supplier statement (bounced / refund / debit note, reconciliation, period split, cancelled debit note + several refunds + date window, isolation) | **PASS 42/42** |
| Full suite `bun test` | **PASS 280/280** across 24 files, two consecutive runs; 0 skipped |
| Concurrency tests proved meaningful | With `CASH_TX` removed (REPEATABLE READ) both race tests fail 3/3; with it they pass 5/5. The old supplier route fails 3 of the 4 statement tests |
| App TypeScript (`tsc --noEmit --incremental false`) | PASS — only the 4 pre-existing errors in `examples/`, `mini-services/` |
| Test TypeScript (`bun run test:types`) | PASS — 0 errors |
| ESLint, all changed / new files, with `react-hooks/refs` as error | PASS — 0 errors; 1 pre-existing warning (`purchase-invoices/[id]/route.ts:98`, unused eslint-disable) |
| Production build (`next build` on a scratchpad copy of the current tree) | PASS |
| Browser (local standalone build, throwaway seeded `manuflow_dev`, headless Chrome) | **PASS 28/28** — admin negative-cash dialog with shortfall; Cancel keeps the form and its amount, saves nothing; override saves and is audit-logged with the user; duplicate dialog lists the matching entry, Save anyway saves; double click on Save → one entry; Adjust Cash refuses a stale review and saves after re-review; duplicate dialog fits 390 px; accountant gets the refusal with "Only a Tenant Admin…" and no override; sales manager sees Payment In only, no load errors, account picker works, financial reports per Option A, Cash & Bank statement API refused; production manager sees Stock Valuation but not P&L / Balance Sheet, P&L API 403; 0 page errors. Idempotency rows recorded for the browser's saves |

**Known limitations / risks:**
1. **Behaviour change for users:** cash outflows that take cash below zero are refused (only a Tenant Admin can save
   them); repeated same-day entries ask for confirmation; roles without `cash-bank` no longer see balances in the
   account picker; sales / purchase invoice lists need the module (or receivables / payables / GST); production /
   plant / quality managers lose the financial report cards. Existing negative cash balances (legacy) make any new
   cash outflow dated on/after the negative day fail until fixed or overridden.
2. **Duplicate check is advisory and not race-proof:** two identical requests sent at the same moment with
   different keys can both pass it (the idempotency key and the client's in-flight de-duplication cover retries and
   double clicks, not two separate devices).
3. **READ COMMITTED** is used for the guarded money transactions (and purchase bills with "paid now"); other
   transactions keep the default. Row-lock order is numbering counter → cash account → idempotency row; deadlocks
   surface as 503 "server was busy — try again".
4. **Idempotency**: a request whose process died keeps its key "in progress" for up to 10 minutes; the stored
   response is the original JSON (later edits to the document are not reflected in a replay); edits, deletes and
   cheque actions are not keyed (they are protected by conditional updates instead).
5. Not gated (outside the approved scope; no balances): `parties/last-rates`, `stock-ledger`.
6. Opening-balance date moved later and cheque clearing-date edits are not checked by the guard (no cash effect
   possible: entries before a new opening date are refused; cheques are bank-only since CB-R5).
7. `MANAGEMENT` sees everything (`'*'`) but cannot override negative cash, by decision.

**Deployment readiness (for a future, separately approved Phase 6 — nothing done):** last verified production
release `20261026-011654` (2026-10-26 ~01:20 IST; DB dump `/home/menu/backups/predeploy/20261026-011654.sql.gz`,
previous release `next-20261026-011654`, both on the server, recorded in the session log, not re-checked). Needed:
`prisma db push` (no data-loss flag) adding the new `IdempotencyKey` table only (additive); fresh verified DB
backup; `deploy.py --check` then `--stage` (server TypeScript / ESLint / build); after deploy: health checks, then a
signed-in smoke test of a cash payment over the balance (refused), a duplicate (dialog), a normal receipt, an
accountant / sales manager login (reports and account picker), the supplier statement print; rollback =
`deploy.py --rollback` (code only — the extra table is harmless to the old code). The deployed code is not in git:
commit first (separate approval; see the `.env` note in the final report).
