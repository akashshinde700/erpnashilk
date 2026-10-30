# Local test report — 2026-10-31

Run of `docs/LOCAL-TEST-PROMPT.md` on a Windows 11 laptop against a **local** MySQL 8.0.45. Code under test:
`erpnashilk/main` at `c6feba3` (PR #14) plus the fixes listed below (branch `security-and-integrity-fixes`).
No production data was touched: tests used `manuflow_test` (through the test-db guard), the manual scenarios used a
fresh `manuflow_dev`, and the restore drill used `manuflow_staging`.

Environment: Node 22.20.0, bun 1.4.4 (installed for this run), Playwright Chromium 1248 (installed for this run),
Prisma client 6.19.3. Each manual scenario ran in its own synthetic tenant (`ZZ-Gate6x …`) created through the
platform API, against the production build (`.next/standalone/server.js`) — not the dev server.

## Verdict (after the follow-up round below): **READY WITH KNOWN RISKS**

The first pass of this report (kept below) ended **NOT READY** on three defects. All three are fixed, an audit
round found and fixed three more, and every gate was re-run on the final build — see "Follow-up round".
The remaining risks are listed at the end of that section.

## First-pass verdict: **NOT READY** (superseded)

The three business guarantees hold (inventory, billing maths, transaction safety — numbers below). The verdict is held
back by three product defects that need a decision before they can be fixed:

1. **Backups miss eight tables** (sales/purchase returns, Cash & Bank accounts, account transactions, loans, batches,
   serials, multi-firm access). The live server's nightly backup has the same gap. A database loss today would lose
   that data; restoring an older backup leaves those tables out of step with the restored invoices.
2. **e-Invoice JSON is rejected by the IRP for any invoice with a discount or freight/packing**: `AssVal` is the
   pre-discount subtotal, item `TotAmt` has no `Discount`, and taxable charges are sent as `OthChrg`.
3. **The material-issue over-issue cap can be bypassed**: it trusts the `requiredQty` the client sends and checks each
   request alone, not the work order's running total.

## Gates

| Gate | Command | Result | Evidence |
|---|---|---|---|
| 0 env | prisma generate / db push / seed / `prepare-db.ts` | PASS | guard accepted `manuflow_test`; seed created 2 tenants |
| 1 lint | `npm run lint` | PASS | 0 errors, 8 warnings (pre-existing) |
| 1 tsc | `npx tsc --noEmit` | PASS after fix | was 5 errors → 0 (`2a3e7b4`, `40af994`; sidecar deps installed) |
| 1 test types | `npm run test:types` | PASS after fix | was 2 errors → 0 (`9795fd7`) |
| 2 build | `npm run build` | PASS | 89/89 pages, exit 0 (re-run after the print fixes: same) |
| 3 Playwright | `next start` + `npx playwright test` | PASS | **151 passed** (3.2 min), no flakes; before the print fixes 148/148 |
| 4 API suite | `bun test` (27 files) | PASS after fix | **325/325** (107 s); first run 323/325 (`d229d14`) |
| 4 concurrency | `bun test tests/production-concurrency.test.ts` ×3 | PASS | 5/5 each run |
| 5 live E2E flag | `E2E_LIVE_API=1 npx playwright test --list` | PASS | throws "Live E2E mode … is not implemented", exit 1 |
| 6A inventory | API + SQL, `ZZ-Gate6A` | PASS (guarantees) / 2 findings | 24/25 + separate cumulative probe, see below |
| 6B billing | API + SQL, `ZZ-Gate6B` | PASS (maths) / 1 finding | 36/37; e-Invoice JSON fails |
| 6C transaction safety | API + SQL, threaded races, `ZZ-Gate6C` | PASS | 13/13 |
| 6D regressions | API + SQL, `ZZ-Gate6D` | PASS | 8/8; quotation + sales-order print XSS found and fixed |
| 7 backup/restore | `daily-backup.mjs` + restore API on `manuflow_staging` | FAIL (coverage) | 10/11; refusals and counts correct, 8 tables not in backup |

### Gate 1/3/4 failures and what they were

| Failure | Product or test | Fix |
|---|---|---|
| `tsc`: `examples/websocket/server.ts` cannot find `socket.io` | config — scaffold example, already ESLint-ignored, never shipped | `2a3e7b4` exclude `examples` from root tsconfig |
| `tsc`: `mini-services/notify-service` cannot find `socket.io` | environment — sidecar deps not installed | `bun install` in that folder, no code change |
| `tsc`: `e2e/support/mock-api.ts` adds unknown-typed GST heads | test | `40af994` `Number()` the heads |
| `test:types`: `out.records` possibly undefined | test | `9795fd7` optional chaining; a missing `records` still fails |
| bun: losing parallel production entry says "must be RELEASED or IN_PROGRESS (current: COMPLETED)", test wanted "exceeds planned qty" | **test** — the route locks the work-order row (line 77) then re-reads it, so a full-qty loser always sees COMPLETED. Stock/ledger/single-winner assertions passed. | `d229d14` accept either refusal message |
| bun: `tally-import` "UTF-16 replies are read the same" timed out once (11.6 s) | test flake under load (Playwright ran in parallel); 5/5 alone, passed in the clean full run | none — noted as a flake risk |
| Playwright: all UI specs stuck on "Loading ManuFlow ERP…" | test setup — default `npm run dev` + `baseURL 127.0.0.1`: Next 16 dev blocks it as a cross-origin dev request; an orphaned dev server on :3000 was then silently reused | ran like CI (`next start`); prompt updated |
| Playwright first run: 113 browser errors | environment — Chromium 1248 not installed | `npx playwright install chromium` |

## Gate 6A — inventory integrity (RM-1 KG @₹10, FG-1 NOS, BOM 1 NOS = 2 KG)

| Step | Observed | Expected | |
|---|---|---|---|
| PO 100 KG @10 → approve → GRN → post | PO created as `PENDING_APPROVAL`; GRN `PENDING_QC` with 0 stock until posted; then **RM-1 = 100.000 KG, ₹1000.00** | 100 KG, ₹1000 | ✔ |
| Issue 30 KG to WO-A (need 20) | **400 "Issued qty exceeds requirement for line"** | prompt said success | prompt contradicted its own step 9; prompt corrected |
| Issue 21 KG → WO-A, 10.5 KG → WO-B | RM-1 **68.5 KG**, 2 issue docs, 2 `ISSUE_OUT` rows Σ **31.5** | 68.5 / 2 / 31.5 | ✔ |
| Produce WO-A 10 NOS | FG +10, RM stays **68.5**, backflush **0** | backflush 0 | ✔ |
| Produce WO-B 5 NOS | FG **15**, RM stays **68.5** | backflush 0 | ✔ |
| WO-C: issue 10 KG, produce 10 NOS | issued **10** + backflushed **10** = **20 KG** = BOM need; RM **48.5** | 20 (not 30) | ✔ |
| Over-issue 11 KG vs need 10 | **400**, stock unchanged (48.5) | refused | ✔ |
| Reconcile | 2 item×warehouse rows: `8.5 = 8.5`, `25 = 25`; 0 ledger groups without a balance; 0 negative balances | all equal | ✔ |
| **Probe:** `requiredQty: 1000`, issue 30 KG on a 10 KG need | **200**, 30 KG left the store | refused | ✘ finding 3 |
| **Probe:** three issues of 10 KG on one 10 KG need (100 KG in stock) | **200, 200, 200** — 30 KG issued | 2nd and 3rd refused | ✘ finding 3 |

Reconcile SQL:

```sql
SELECT b.itemId, b.warehouseId, ROUND(b.qty,4) bal, ROUND(COALESCE(l.net,0),4) led
FROM StockBalance b LEFT JOIN (SELECT itemId, warehouseId, SUM(qtyIn-qtyOut) net FROM StockLedger
  WHERE companyId=? GROUP BY itemId, warehouseId) l ON l.itemId=b.itemId AND l.warehouseId=b.warehouseId
WHERE b.companyId=?;
SELECT COUNT(*) FROM StockBalance WHERE companyId=? AND qty < -0.0001;
```

## Gate 6B — billing accuracy (round-off ON, intra-state, B2B customer with GSTIN)

Hand calculations in paise; every identity in the prompt was checked on the saved row.

| Invoice | subtotal | disc | taxable | CGST | SGST | freight | packing | round-off | grand total | hand |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 — 12.5 KG × 480.50, 2.5 % | 6006.25 | 150.16 | **5856.09** | 527.05 | 527.05 | 0 | 0 | −0.19 | **6910.00** | 6910.00 ✔ |
| 2 — 3 BOX (=72 PCS) @ ₹1000/box | 3000.00 | 0 | **3000.00** | 270.00 | 270.00 | 0 | 0 | 0 | **3540.00** | 3540.00 ✔ |
| 3a — 3×₹100, bill disc ₹100, freight 250@18, packing 75@12 | 300 | 100 | **200.00** | 45.00 | 45.00 | 250 | 75 | 0 | **615.00** | 615.00 ✔ |
| 3b — same, bill disc **₹1** (paise-drift case) | 300 | 1 | **299.00** | 53.91 | 53.91 | 250 | 75 | +0.18 | **732.00** | 732.00 ✔ |

* Invoice 2 line stored in base unit: qty **72**, rate **41.6667** (`r4`), line total **3000.00** — no drift.
* The prompt's invoice 3 (₹100 discount) cannot give 299.00; the drift case needs a ₹1 discount. Both ran; prompt corrected.
* **GSTR-1 JSON** (`data.json`, b2b): Σ txval **10005.09** = Σ invoice taxable incl. freight/packing; Σ camt = Σ samt =
  **895.96** = Σ invoice CGST/SGST. ✔
* **Tally XML**: invoice 1 legs −6910.00 / +5856.09 / +527.05 / +527.05 / −0.19 → Σ **0.00**; invoice 3a Σ **0.00**;
  party leg = grand total. ✔
* **e-Invoice JSON** (invoice 1): `ValDtls` = `AssVal 6006.25`, `CgstVal 527.05`, `SgstVal 527.05`, `RndOffAmt −0.19`,
  `TotInvVal 6910`. AssVal + taxes + round-off = 7060.16 ≠ 6910; item `TotAmt = AssAmt = 5856.09`, no `Discount`. ✘
  finding 2 (`src/lib/einvoice.ts:187`, `:236`; freight/packing go to `OthChrg` although GST is charged on them).
* **Sales return** 2.5 KG on invoice 1: stock 37.5 → **40.0**; `SALE_OUT` costRate **300**, `SALES_RETURN_IN` rate
  **300** (back at cost, not the ₹480.50 sale rate); invoice `PARTIALLY_PAID`, settled **1382.00** = credit note
  total; credit note listed in GSTR-1 `cdnr`. ✔
* **Not run by hand:** the dialog preview and A4/A5 print preview in a browser. The print/totals maths is covered by
  `e2e/unit/billing-totals.spec.ts` and `print-document.spec.ts` (pass), not by an eyeball check.

## Gate 6C — transaction safety

| Check | Observed | |
|---|---|---|
| Invoice with line 2 qty 5 > stock 3 | **409** "Insufficient stock for B Part B: 3 available…, 5 required"; 0 `SalesInvoice`, 0 sale ledger rows; A stays 10, B stays 3; no number counter row created; next good invoice got **…000001** | ✔ |
| Same `Idempotency-Key` twice — invoice | 200 + 200, same id, one row, stock moved once (A 8 → 7) | ✔ |
| Same key, different payload — invoice | **422** "This Idempotency-Key was already used for a different request" | ✔ |
| Same key — material issue / production entry | 200, 200, then 422 on a changed payload; RM 30 → 26 once; one entry, FG +2 once | ✔ |
| Race: two full-qty production entries (threads, barrier) | **200 + 400** (loser: "…current: COMPLETED"); FG **+4** (not 8); RM **−8** once | ✔ |
| Race: two issues of 10.8 KG with 18 KG available | **200 + 400** "available 7.2, needed 10.8"; RM **7.2**, never negative | ✔ |
| Cancel the good invoice | 200; row kept as `CANCELLED`; A 7 → 9, B 2 → 3; reversing ledger rows; customer outstanding 472 → 118 (−354 = invoice total) | ✔ |
| Payment ₹500 more than the bill | **400** "Amount exceeds outstanding (₹118.00)"; `paidAmount` 0; 0 Payment, 0 AccountTxn rows | ✔ |

No hang or deadlock was seen, so no `SHOW ENGINE INNODB STATUS` capture was needed.

## Gate 6D — regressions

| Check | Observed | |
|---|---|---|
| GSTR-2 reverse charge | bill flagged; supplier row `rcmBills 1`, taxable 1000, CGST 90 + SGST 90; RCM block `rcmBills 1`, `rcmTaxable 1000`, `rcmTax 180` | ✔ |
| Tally purchase push, `TALLY_CONNECTOR_POC=1`, push flag off | **503** `TALLY_PUSH_DISABLED` "Push to Tally is not switched on…". With POC also off: 503 `TALLY_CONNECTOR_UNAVAILABLE` | ✔ |
| Transfer 5 KG RM → GEN, adjust −2 KG "Rust damage" | RM **15**, GEN **3**; ledger == balance; adjustment row notes carry the reason | ✔ |
| Party name `</title><script>…</script> Co & "Sons"` | stored verbatim; Statement of Account escapes title (`printDocument`) and body (`esc`) | ✔ |
| Same name in a **quotation / sales order print** | body wrote party, city, GSTIN, item names raw → stored XSS; header hardcoded "Acme Precision Manufacturing Pvt Ltd" on every tenant | ✘ → fixed `d27dbb9`, `9f9eb6e` + `e2e/unit/print-quotation.spec.ts` |
| Live Tally connector push ("imported") | **NOT RUN** — no TallyPrime/connector on this machine | — |

## Gate 7 — backup & restore drill (`manuflow_staging`, Acme tenant + a bank account, a bank txn and a sales return)

| Check | Observed | |
|---|---|---|
| `daily-backup.mjs` | exit 0, **0.19 s** for 2 companies; Acme file **7925 bytes**, `meta.version 1`, `meta.counts`, `data` | ✔ |
| Backup holds every table with rows | `SalesReturn`, `MoneyAccount`, `AccountTxn` had rows and are **absent**; also never backed up: `PurchaseReturn`, `Loan`, `ItemBatch`, `ItemSerial`, `UserCompanyAccess` | ✘ finding 1 |
| Restore another company's file | **400** "This backup belongs to a different company…" | ✔ |
| Wrong company name typed | **400** "Type the company name exactly to confirm" | ✔ |
| Truncated JSON | **400** "This is not a ManuFlow backup file" | ✔ |
| Data after the three refusals | unchanged (all compared counts equal) | ✔ |
| Real restore | **200** in **0.11 s** (RTO on this tiny tenant); customer added after the backup is gone | ✔ |
| `meta.counts` vs rows after restore | customers 3/3, items 12/12, salesInvoices 1/1, salesInvoiceItems 1/1, stockLedger 12/12, stockBalances 12/12, payments 1/1, users 9/9, boms 3/3, numberSeqs 11/11, expenses 2/2 | ✔ |
| UI safety download before restore | **NOT RUN** — drill used the API, not the Settings screen | — |

## Still unverified

* Browser checks done by eye: invoice dialog preview, A4/A5 print preview, the Settings → Restore screen and its safety
  download.
* A live Tally connector import.
* RTO on a realistic data volume (0.11 s is a seed-sized tenant).

## Decisions needed (not fixed in this run)

1. **Backup coverage** — add the eight tables (and their item tables) to `GET /api/companies/[id]/backup`,
   `scripts/daily-backup.mjs` and the restore route, in FK order inside the restore transaction, with a regression test
   that fails when a company-scoped model is missing from the backup.
2. **e-Invoice values** — per line: `TotAmt` = gross, `Discount` = line + bill-discount share, `AssAmt` = taxable;
   `AssVal` = Σ `AssAmt`. Freight/packing carry GST, so they need to go in as their own service lines (SAC 9965 / 9985
   or as the business decides) rather than `OthChrg`.
3. **Over-issue cap** — compute the requirement on the server (BOM × planned qty, less material already issued to the
   work order) and keep the 5 % margin on that running total.

## Commits from this run

| Commit | What |
|---|---|
| `2a3e7b4` | chore(tsc): exclude scaffold examples from the root type check |
| `40af994` | test(e2e): coerce GST heads to numbers in the mock GSTR-2 register |
| `9795fd7` | test(tally): guard optional records in connector push assertions |
| `d229d14` | test(production): accept the status refusal for a losing parallel entry |
| `d27dbb9` | fix(print): escape quotation print body and use the tenant's own company |
| `9f9eb6e` | fix(print): escape sales order print and drop the hardcoded company name |

## Follow-up round (same day) — fixes and re-run

| ID | Severity | Issue | Fix | Regression test |
|---|---|---|---|---|
| F-1 | Critical | Backups (download + nightly) left out returns, Cash & Bank, loans, batches, serials, firm access | `defc83c` table list derived from the Prisma schema in FK order; backup **version 2**; a v1 file leaves tables it lacks untouched and says so; a v2 file missing a table, or lines without their header, is refused before anything changes | `tests/backup-plan.test.ts` (7) |
| F-2 | High | e-Invoice JSON rejected by the IRP for any discount or freight/packing | `6edc126` lines carry gross / discount / taxable with tax worked out as `computeBillTotals`; freight and packing are taxable service lines (SAC 996511 / 998540) | `e2e/unit/einvoice-values.spec.ts` (3) |
| F-3 | High | Over-issue cap trusted the client's `requiredQty` and was per request | `b48baba` requirement computed on the server (BOM × planned qty), cap covers issues + backflush under the work-order lock; items not on the BOM refused | `tests/material-issue-cap.test.ts` (7, incl. a parallel race) |
| F-4 | High | Line discount above 100 % accepted → negative taxable value and bill; qty 1e15 accepted (paise lost) | `540c1e3` both shared calculators refuse discount/GST/cess outside 0–100 %, non-finite or oversized qty/rate, line value > ₹1e11, bad freight/packing | `e2e/unit/bill-line-limits.spec.ts` (9) |
| F-5 | Medium | No clickjacking protection, no HSTS | `e3a2b49` `X-Frame-Options: DENY`, CSP `frame-ancestors 'none'`, `Strict-Transport-Security` | audit probe on the production build |
| F-6 | Low | Two unused packages with advisories; `bun.lock` behind `package.json` | `860bda7` removed `@mdxeditor/editor`, `react-syntax-highlighter`; lockfile regenerated | build + full suites |

Audit probes on the final production build (two synthetic tenants, `gaudit.py`): tenant B could not read, cancel, pay
or bill tenant A's invoice / customer / item / Tally XML / e-Invoice / backup (404/403 with either company header);
spoofed `x-erp-*` headers ignored; anonymous → 401; operator refused on invoices, payments, users and backup; eight
wrong passwords → 429; negative / zero / NaN quantities and rates, negative receipts, negative-stock adjustments,
duplicate codes, empty and malformed JSON all refused with 4xx (no 500). Raw SQL is parameterised (`$queryRaw`
templates only); the error handler never returns internals.

### Re-run on the final build

| Gate | Result |
|---|---|
| lint / tsc / test types | 0 errors (8 pre-existing lint warnings) |
| build | PASS, 89/89 pages |
| Playwright (`next start`) | **163 passed** (3.5 min) |
| `bun test` | **339/339** across 29 files |
| 6A / 6B / 6C / 6D | 25/25 · 37/37 · 13/13 · 8/8 (the over-issue probes and the e-Invoice check now pass) |
| 7 backup/restore | backup v2 holds returns + Cash & Bank; three refusals; counts match; restore 0.21 s |
| audit probes | 34/35 — the one "fail" is a 7 % GST rate being accepted, left as is on purpose (below) |

### Known risks left open

* **`xlsx` 0.18.5** (prototype pollution, ReDoS; parses uploaded import files). npm has no fixed release; the fix is
  SheetJS 0.20.3 from `cdn.sheetjs.com`, which needs an explicit decision to take a package from outside the npm
  registry. Uploads are already size- and row-capped and only reachable by signed-in users with import rights.
* **`sharp` 0.34** advisories (libvips) — fixed only in a major upgrade; Next uses it for image optimisation.
* **`prisma` CLI** (`deepmerge-ts` advisory) — build/CLI tooling, not reachable at runtime.
* **GST rate slabs** are not enforced (any 0–100 % is accepted): which slabs are valid is a legal/business rule that
  changed with GST 2.0, so it is not hard-coded.
* Browser-only checks still not done by eye: invoice dialog preview, A4/A5 print preview, Settings → Restore screen.
