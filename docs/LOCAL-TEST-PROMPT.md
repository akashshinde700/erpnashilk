# Local test run — prompt for Claude Code

**Kaise use karein:** repo root me `claude` chalao, phir neeche `--- PROMPT START ---` se `--- PROMPT END ---` tak
ka poora text copy-paste kar do. Bas apni MySQL ka password bhar dena (jahan `CHANGE_ME` likha hai), aur bata dena ki
staging database kaun sa hai. Baaki sab Claude khud chalayega aur end me report dega.

Ye prompt specifically un 3 guarantees ko verify karta hai jo release ke liye zaroori hain — **inventory integrity**,
**billing accuracy**, **transaction safety** — plus backup/restore drill aur pichhle audit me fix hui cheezein.

Expected green state (aaj ke code par): Playwright **151 passed**, `bun test` **27 files / 325 tests pass**, `npm run lint`
**0 errors**, `npx tsc --noEmit` **0 errors** (local par real Prisma client generate hota hai, isliye 0 — koi error aaye
to wo asli bug hai).

---

## --- PROMPT START ---

You are a senior QA engineer + full-stack developer working in this repository (**ManuFlow**, a multi-tenant
manufacturing ERP: Next.js 16 App Router, Prisma + MySQL, Playwright, bun). Your job in this session is **to actually
run every test that can only run locally (real MySQL) and to verify the three business guarantees by hand**, then report
honestly. Read this whole prompt before running anything.

### Non-negotiable rules

1. **Never touch production data.** Only use the dedicated test database (`TEST_DATABASE_URL`, name must end `_test`)
   and, for the drill, a **staging** database I name below. Do not run `prisma db push`, `db:reset` or any destructive
   SQL against anything else. Do not modify `.env` values that point at production.
2. **Never claim a test passed unless you ran it and saw the output.** If a step cannot run (missing service, no
   browser), say `NOT RUN` and why — do not guess.
3. **Do not weaken the app to make a test pass**: no disabling validation, no `--force`, no deleting/skipping tests, no
   hardcoded success. If an assertion fails, decide whether the *code* or the *test* is wrong and say which.
4. **Do not print secrets or customer data.** Redact `DATABASE_URL` passwords, tokens, session cookies, GSTINs of real
   parties. Use synthetic data only.
5. **Small steps, one commit each.** Fix → re-run the affected gate → commit. Do not bundle unrelated changes.
6. If something is ambiguous, inspect the code first (`docs/`, `prisma/schema.prisma`, the route handler) and write down
   what you assumed instead of inventing behaviour.

### What I want at the end

A single report (markdown, saved as `docs/LOCAL-TEST-REPORT-<today>.md` **and** pasted in chat) with:

* a table: gate → command → result (`PASS` / `FAIL` / `NOT RUN`) → evidence (counts, exit code, key numbers);
* for each manual business scenario: what you did, the **numbers you observed** (stock qty, bill totals to the paisa),
  and expected vs actual;
* every failure: root cause, whether it is a product bug or a test bug, and the fix (with commit hash + regression test);
* a final verdict: **READY** / **READY WITH KNOWN RISKS** / **NOT READY**, with the exact list of what is still
  unverified.

---

## Step 0 — environment

```bash
# Node 22, bun, MySQL 8 running locally
node -v && bun -v && mysql --version

# Test database (only if missing)
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS manuflow_test CHARACTER SET utf8mb4;"
mysql -u root -p -e "CREATE USER IF NOT EXISTS 'manuflow_test'@'127.0.0.1' IDENTIFIED BY 'CHANGE_ME';"
mysql -u root -p -e "GRANT ALL ON manuflow_test.* TO 'manuflow_test'@'127.0.0.1'; FLUSH PRIVILEGES;"

export TEST_DATABASE_URL='mysql://manuflow_test:CHANGE_ME@127.0.0.1:3306/manuflow_test'

# Dev/app database (fresh, for the manual scenarios in Gate 6)
export DATABASE_URL='mysql://root:CHANGE_ME@127.0.0.1:3306/manuflow_dev'
export SESSION_SECRET="$(openssl rand -base64 48)"

npm install
npx prisma generate          # must succeed locally (this is why tsc can be clean here)
npx prisma db push           # only against manuflow_dev, never production
bun prisma/seed.ts           # demo tenant + admin (prints the login it created)
```

Then confirm the guard is happy before any test:

```bash
bun run test:db:prepare      # creates the schema + marker in manuflow_test only
```

If the guard refuses (`[test-db-guard] Refusing…`), **stop** and show me the message — do not work around it.

---

## Gate 1 — static gates (must be clean, these are cheap)

```bash
npm run lint                 # expect: 0 errors (8 warnings are pre-existing and acceptable)
npx tsc --noEmit             # expect: 0 errors with a real prisma client
npm run test:types           # tsconfig for tests/
```

Anything failing here is a real defect in the branch — fix it first, re-run, then continue.

## Gate 2 — build (production build, not dev)

```bash
npm run build                # next build; must finish with all pages generated
```

## Gate 3 — Playwright suite (UI + pure functions, no DB needed)

```bash
npm run build
E2E_WEB_COMMAND="npx next start -p 3000" npx playwright test --reporter=list
```

Run it against the production server, as CI does. The default web command (`npm run dev`) loads the app from
`127.0.0.1`, which Next 16 dev blocks as a cross-origin dev request, so every UI spec hangs on "Loading ManuFlow
ERP…". Make sure nothing else is listening on port 3000 first: `reuseExistingServer` silently reuses it.

Expected: **151 passed** (`e2e/specs` 11 files + `e2e/unit` 7 files). Run it twice if any flake appears and note which
test flaked — flaky tests are a finding, not a pass.

## Gate 4 — API suite against real MySQL (this is the one that needs my machine)

```bash
bun test                                      # whole suite, 27 files
bun test tests/production-concurrency.test.ts # the 5 race / idempotency cases, run alone too
```

What must hold in `tests/production-concurrency.test.ts` (read the file, it documents the intent):

* two parallel production entries for the full planned qty → **exactly one** succeeds, FG stock `+10` (not 20),
  RM `-20` (not -40), one entry row, work order `COMPLETED`, ledger agrees with the balance;
* five parallel entries → saved entries == produced stock == work-order counter;
* a retried submission with the same `Idempotency-Key` → same entry id, one row, stock moved once;
* same key + different payload → **422**;
* a failed entry (material short) → **409**, stock untouched, key released so the corrected retry succeeds.

If any of these hang instead of returning, that is a **deadlock/lock bug** — capture `SHOW ENGINE INNODB STATUS\G`
and report it, don't just retry.

## Gate 5 — "live E2E": there is no live mode (verify that nobody believes otherwise)

This repo's Playwright suite **always** runs the UI against an in-browser fake API (`e2e/support/mock-api.ts`), so it
proves the screens and the client-side maths, **not** the database. The old docs said `E2E_LIVE_API=1` would switch to a
real database; that flag was never implemented, so it now **fails loudly**:

```bash
E2E_LIVE_API=1 npx playwright test --list
# expect: Error: Live E2E mode (E2E_LIVE_API / E2E_MODE=live) is not implemented … (non-zero exit)
```

Confirm you get that error, and then get the real-database coverage from **Gate 4 (`bun test`) + Gate 6 (manual)** —
those are the only places where Prisma, stock movements and money maths actually touch MySQL. If you find any script,
README line or CI job that still implies a live E2E mode, fix the text.

## Gate 6 — the three guarantees, by hand (most important part)

Do these through the real UI (or the real API with curl if a screen is blocked), against `manuflow_dev`, with synthetic
data. Record every number. Where something does not exist in this product, say "not modelled" instead of inventing it —
this ERP has **work orders / material issues / production entries**, not job cards or weight-based billing.

### 6A. Inventory integrity — one inward receipt split across several job cards

1. Items: `RM-1` (KG, purchase price ₹10/kg, moving average), `FG-1` (NOS, standard cost ₹100), BOM `BOM-1` for `FG-1`
   = output 1 NOS needs **2 KG** of `RM-1`.
2. Warehouses: `RM-STORE` (type RM), `FG-STORE` (type FG).
3. Vendor + PO for **100 KG** `RM-1` @ ₹10 → GRN against it (inward 100 KG). Check Stock Balance: `RM-1 = 100.000 KG`,
   value ₹1000.
4. Two work orders: **WO-A** planned 10 NOS, **WO-B** planned 5 NOS (both for FG-1).
5. Issue material: **21 KG to WO-A** and **10.5 KG to WO-B** (split of the same inward; that is each work order's
   requirement + the 5 % cap — 30 KG against a 20 KG requirement is refused, see step 9).
   *Expected:* `RM-1` balance **68.5 KG**; two material-issue documents; a stock-ledger `ISSUE_OUT` row for each; the sum
   of ledger `qtyOut` for RM-1 = 31.5.
6. Produce on WO-A: report **10 NOS**, 0 rejected. BOM need = 20 KG, already issued 21 KG → backflush must consume
   **0 KG** (already more than needed). Check: entry succeeds, FG-1 +10, RM-1 stays 68.5.
7. Produce on WO-B: report **5 NOS** → need 10 KG, issued 10.5 → backflush **0**. RM-1 stays 68.5.
8. Now the double-consumption check, fresh pair of work orders: **WO-C** planned 10, issue only **10 KG**, then report
   10 NOS. Need is 20, issued 10 → backflush exactly **10 KG** → RM-1 drops by 10, and **total consumed for WO-C = 20 KG
   = BOM requirement** (not 30). This is the "remaining qty never wrong" check.
9. Over-issue guard: try to issue **11 KG** against a 10 KG requirement (**+5 % cap**) → must be refused with a clear
   message, stock unchanged.
10. Reconcile: for every item, `SUM(StockLedger.qtyIn - qtyOut)` == `StockBalance.qty` per warehouse, and no negative
    balance anywhere. Paste the SQL you used and the result set.
11. Also probe the cap itself: send `requiredQty` larger than the BOM need, and issue the full requirement twice on one
    work order. Today both go through (the cap trusts the client's `requiredQty` and is per request) — see
    `docs/LOCAL-TEST-REPORT-2026-10-31.md`.

### 6B. Billing accuracy — per-kg, per-piece and lot charges, one set of numbers everywhere

Create three invoices and check that **preview → saved row → printed document → GSTR-1** agree to the paisa.

* **Invoice 1 — per kg:** 12.5 KG × ₹480.50, line discount 2.5 %, GST 18 % intra-state.
* **Invoice 2 — per piece with a secondary unit:** an item sold in BOX = 24 PCS, qty 3 BOX at a per-box rate
  (the line must convert to base qty, and the line total must not drift — this is what `r4()` exists for).
* **Invoice 3 — bill-level charges:** three lines ₹100 each (qty 1, 18 %), **bill discount ₹1**, **freight ₹250 @18 %**,
  **packing ₹75 @12 %**, round-off ON.

For each invoice verify, in this order:

1. the dialog preview,
2. the saved document (API `GET /api/sales-invoices` / the detail row),
3. the print output (A4 **and** A5; use the browser print preview, screenshot or save as PDF),
4. **GST Reports → GSTR-1** for that month (and the JSON export behind it,
   `GET /api/reports/gstr1-json?companyId=…&month=YYYY-MM`) — the monthly tax heads,
5. `GET /api/sales-invoices/:id/tally` (Tally XML) and the e-Invoice JSON if the invoice is B2B with a GSTIN.

Acceptance (compute these by hand, in paise, and compare):

* `Σ(line taxable)` == bill taxable == `subtotal − discountTotal`;
* `CGST + SGST` == `Σ(line tax)` exactly (IGST for inter-state);
* `grandTotal` == `Σ line taxable` + freight + packing + tax + cess ± `roundOff`, and with round-off ON the grand total
  is a whole rupee with `|roundOff| ≤ 0.50`;
* for invoice 3: three lines of ₹100 with ₹1 bill discount → taxable **299.00**, not 299.01, and the grand total equals
  the sum of its own printed lines. (This is the exact bug fixed in `computeBillTotals`; if you ever see 299.01 the fix
  regressed.)
* GSTR-1 monthly totals == sum of the invoices' tax heads; Tally XML balances (party debit == Σ credits);
  the printed grand total == the saved `grandTotal`.

Then do the **returns** side once: sales return (credit note) against invoice 1 → stock comes back at the recorded cost,
invoice balance drops, GSTR-1 shows it in the credit-note section.

### 6C. Transaction safety — half-saved documents must be impossible

1. **Forced failure mid-save:** create an invoice with two lines where the second line's qty exceeds the stock in the
   warehouse. Expected: HTTP **409**, **no** `SalesInvoice` row, **no** `StockLedger` rows for it, no stock moved for the
   first line either, and the document number is not silently consumed (check the numbering table before/after — if the
   number *is* consumed, report it as a documented gap, not a crash).
2. **Idempotent retry:** POST the same invoice/`production-entries`/`material-issues` request twice with the same
   `Idempotency-Key` header → exactly one document; replay returns the original body. Then reuse that key with a
   different payload → **422**.
3. **Real race:** fire two `POST /api/production-entries` for the same work order with `curl &` at the same time
   (full planned qty in both) → one 200 + one 400 (the loser waits on the work-order lock and sees it COMPLETED), FG stock `+planned` (not doubled), RM consumed
   exactly once. Repeat for two `POST /api/material-issues` that together exceed the available stock → one succeeds.
4. **Cancel gives it all back:** cancel the invoice from (1) after a successful save → stock returns, ledger has the
   reversing rows, party balance back to the previous value, and the invoice is `CANCELLED` (not deleted).
5. **Failed payment** (e.g. amount larger than the bill): refused, `paidAmount` unchanged, no cash/bank row created.

### 6D. Regressions from the last two releases (quick, 10 minutes)

1. **Print title escaping (stored XSS fix):** create a customer named `</title><script>alert('xss')</script> Co`, then
   print its **Statement of Account** (Receivables → print). Expected: no alert, the title shows the literal text, and
   the printed body renders normally. Also try a party name with `&` and `"`.
2. **Tally purchase-bill push:** with `TALLY_CONNECTOR_POC=1` and `TALLY_CONNECTOR_PUSH=1` on the server, open
   **Purchase Invoices → Tally** on one bill. Expect a job, then either "imported" (real/mock connector) or a clear
   refusal — never a silent no-op. Without those env flags it must answer **503** with the "not switched on" message.
3. **GSTR-2:** mark one purchase bill as reverse charge → it shows the `RCM` badge, the supplier row shows `N RCM`, and
   the "self-assessed, claim under 3.1(d)" line sums it.
4. **Stock transfer + adjustment:** move 5 KG between warehouses, then adjust −2 KG with a reason → balances and ledger
   agree, and the ledger rows carry the reason.

---

## Gate 7 — backup & restore drill (staging only)

Follow `docs/release-checklist.md` exactly, on the **staging** database I give you (never production):

```bash
BACKUP_DIR=/tmp/mf-backup BACKUP_KEEP_DAYS=14 DATABASE_URL="$STAGING_DATABASE_URL" node scripts/daily-backup.mjs
ls -lh /tmp/mf-backup/*/*.json.gz && zcat /tmp/mf-backup/*/*.json.gz | head -c 300
```

1. The file is non-trivial in size and contains `meta.version`, `meta.counts`, and data.
2. Restore it into staging via **Settings → Data & Backup → Restore** (type the company name to confirm). The UI must
   first download a safety backup of the current data.
3. Compare `meta.counts` with post-restore row counts per table → must match exactly.
4. Negative tests: a backup file of **another** company → refused; wrong company name typed → refused; truncated JSON →
   refused with a readable error, and **staging data unchanged**.
5. Record timings: backup duration, restore duration (this is your RTO number), and the counts you compared.

---

## If something fails

1. Reproduce it twice, capture the request/response, the SQL effect, and the exact command.
2. Decide: product bug or test bug. Write down the reasoning.
3. Product bug → fix the **code** (never the assertion), add a regression test in the right place
   (`e2e/unit/*` for pure logic, `tests/*.test.ts` for DB behaviour, `e2e/specs/*` for UI), re-run the affected gate and
   the full suite, commit separately with a message that explains the user-visible impact.
4. If a fix needs a schema change or touches money columns, **stop and ask me** — that is a separate release
   (`docs/money-precision-plan.md` explains why).

Start with Step 0, then run the gates in order, and keep a running log in the report file as you go so nothing is lost if
the session ends.

## --- PROMPT END ---

---

### Notes for you (not part of the prompt)

* **Gate 4 (bun test) aur Gate 6 hi asli value hain** — sandbox me MySQL nahi tha, isliye wahan sirf Playwright (mock API) chal
  paaya. Ye do gates pehli baar real database par chalenge. Note: "live E2E" ka mode is repo me **nahi** hai (purana
  `E2E_LIVE_API` flag ab error deta hai) — pehle wahan jhoothi green mil sakti thi.
* **Gate 6B step 3 (₹299.00)** wo exact case hai jisme pehle 1 paisa drift hota tha — agar kabhi 299.01 dikhe to
  `computeBillTotals` regress ho gaya hai.
* **Gate 7** destructive hai — sirf staging par, aur pehle ek dump le lo (`docs/release-checklist.md` §1).
* Report file naam: `docs/LOCAL-TEST-REPORT-<date>.md` — usse repo me rakh lena, taaki next release me compare kar sako.
