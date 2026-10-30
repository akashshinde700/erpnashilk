# Code review — ManuFlow (2026-10-30)

Tool: **OpenCodeReview** (`@alibaba-group/open-code-review`, `ocr` v1.13.3, commit `375f64c`) — [alibaba/open-code-review](https://github.com/alibaba/open-code-review).
Mode: **delegation** (`ocr delegate`, the mode the tool documents for "no LLM configuration required"): the tool does the
deterministic half — file selection and rule resolution — and the host agent performs the review against those rules.
No model endpoint, API key or code upload was involved, and no credentials were requested.

```bash
npx @alibaba-group/open-code-review          # installed into /tmp, binary runs offline
ocr delegate preview                         # 358 reviewable files / 501 total
ocr delegate rule <files> --background-file brief.md     # resolved ruleset per file bundle
ocr rules check src/lib/erp-helpers.ts       # single-file rule lookup
```

Selected corpus: **358 reviewable files** (the tool excludes binary/`.md`/lock/pid files). Reviewed in depth — the
money, stock, security and document paths plus the screens that print or post them:

`src/lib/{erp-helpers,accounting,manufacturing,idempotency,batches,sale-cost,gst-reports,credit-apply,party-credits,cash-guard,session,use-api,units}.ts`,
`src/lib/tally/*`, the API routes for sales/purchase invoices, stock, stock-ledger, adjustments, transfers, work orders,
production entries, material issues, payments, GSTR-2, company backup/restore and the Tally push, plus
`sales-invoices.tsx`, `stock.tsx`, `work-orders.tsx`, `purchase-invoices.tsx` and `kit.tsx`.

Rule groups applied (the tool's built-in `system` ruleset for `**/*.{ts,tsx,js,mjs}`): dead code, duplicate code,
hardcoding, `var`/loose equality, `any` usage, null checks, nested ternaries, React hook / state / render-side-effect
rules, async error handling and `Promise.all` usage, and the security block (XSS, `innerHTML`, `eval`/`Function`,
`document.write`, secrets, prototype pollution).

---

## Findings

| # | Sev | Where | What | Status |
|---|---|---|---|---|
| 1 | **High** | `src/components/erp/kit.tsx` `printHtml()`, called with user text from `receivables.tsx:226` and `payables.tsx:206` | The print shell interpolated the document **title** into `<title>${title}</title>` unescaped. The title carries the party name ("Statement of Account — …"), so a party named `</title><script>…` ran script in the print window — which inherits the app origin, making it a **stored XSS** (CSV/party import is enough to plant it, one click on Print to trigger). | **Fixed** — `printDocument()` in the new `src/lib/html.ts` escapes the title (attributes included); body markup stays caller-built. 4 unit tests in `e2e/unit/print-document.spec.ts` (the real payload, quotes/ampersands, body untouched, complete document). |
| 2 | **Medium** | `eslint.config.mjs` | The lint gate had `no-unreachable`, `no-redeclare`, `no-fallthrough`, `prefer-const`, `no-unused-vars` and `no-explicit-any` switched **off**, so the rules above were not enforceable in CI. Measured before changing: with those four enabled the codebase has **0 findings**; `no-unused-vars` has **201**, `no-undef` **17** (all false positives — `React`, `NodeJS`, `BodyInit`, `RequestInit`; TypeScript already covers it). | **Fixed (safe subset)** — the four clean rules are ON and each remaining exception is documented in the file with its count and reason. `no-unused-vars` stays off until the 201 are cleaned; the count is now written down instead of being invisible. |
| 3 | **Low** | `e2e/support/fixtures.ts:25` | `npm run lint` (`eslint .`) was **already failing** with `react-hooks/rules-of-hooks` on Playwright's fixture `use()` — a false positive, but it made the lint command red for everyone. | **Fixed** — scoped `eslint-disable-next-line` with the reason. `eslint .` is now 0 errors / 8 warnings (all pre-existing `no-location-assign-relative-destination` and one stale disable). |
| 4 | Medium | `src/app/api/material-issues/route.ts:107-121` (availability guard), `src/lib/manufacturing.ts` backflush | `for (const line of lines) await availableQty(...)` — one query per line, then one per BOM component during backflush. Correct, but an O(n) round-trip pattern on a hot write path; a 50-line issue costs 50 queries before anything is written. | **Open** (performance). Fix: one `groupBy(itemId)` availability query, then compare in memory; the shortage list already prints per item. |
| 5 | Low | 64 × `: any` under `src/app/api/**` (e.g. `deliveries/route.ts:27`, `[id]/route.ts:201,296`) | Untyped request bodies. The ruleset asks for a justifying comment when `any` is used; most of these have none. | **Open**. Cheap first step: a `parseBody<T>()` helper or `unknown` + field checks at the boundary; these are exactly the spots where a typo becomes a 500 instead of a 400. |
| 6 | Low | `src/components/erp/party-form.tsx:209` | The IFSC lookup calls `https://ifsc.razorpay.com/<code>` **from the browser**: a third-party dependency in a core form, fails offline, and tells a third party which bank branch the user is typing. | **Open**. Move it behind `/api/ifsc/:code` (server-side, cached, 5 s timeout) so the browser talks to one origin; make the base URL configurable. |
| 7 | Info | `src/components/erp/kit.tsx` `printHtml()` | `document.write()` is on the ruleset's "prohibited" list (reflow). Here it is the only reliable cross-browser way to open a print window with inline CSS, and the tool cannot replace it without a print route. | **Accepted, contained** — the only `document.write` in the repo now lives in one function with an escaping contract documented in `src/lib/html.ts`. Follow-up option: `window.open()` + `document.body.innerHTML`, or a `/print/...` route. |
| 8 | Info | `src/components/ui/chart.tsx:83` | `dangerouslySetInnerHTML` — vendored shadcn chart CSS injection, no user data. | No change. |
| 9 | Info | ~30 × `== null` / `!= null` | The ruleset bans `==`; these are the deliberate null-or-undefined idiom (e.g. `boms.tsx:256`, `grns/route.ts:170`). | No change; if the team wants it enforced, configure `eqeqeq` with `{ null: 'ignore' }` so the intent is written down. |

### Checked and clean (the ruleset's deterministic items, verified by search + reading)

* No `var` declarations anywhere in `src/`.
* No `eval`, `new Function`, string-argument `setTimeout`/`setInterval`.
* No `document.write` outside the single print helper; no `innerHTML` with user input; no prototype mutation.
* No hardcoded secrets, API keys or tokens in `src/`, `scripts/` or `connector/`.
* Every async API route is wrapped in `try/catch` → `handleError`, so a thrown `ApiError` becomes a user-facing 4xx/5xx
  envelope instead of an unhandled rejection.
* React: no `useEffect` without a dependency array, no components declared inside components, no render-phase side
  effects in the reviewed screens, hooks only at the top level.
* Money paths reviewed against the ruleset's arithmetic concerns: integer-paise bill maths (`computeBillTotals`),
  sale reversal at the **recorded** cost (`liveSaleRows`), stock only through the locked `postStock()`.
* Tenant scoping re-checked on every reviewed route (`companyId` from the session, parent-row scoping on line tables).

## Verification after the fixes in this PR

| Check | Result |
|---|---|
| `next build --webpack` | ✅ 88/88 pages |
| `npx playwright test` | ✅ **132 passed** (was 128; +4 new print-document tests) |
| `npx eslint src e2e` | ✅ **0 errors**, 8 warnings (all pre-existing) — previously 1 error |
| `npx tsc --noEmit` | unchanged stub noise, no errors in the changed files |

## Not in this review's scope

No dependency/CVE audit, no dynamic penetration test, no load test. The concurrency claims are covered by
`tests/production-concurrency.test.ts` (needs a MySQL to run) and were not executed in this environment.

## Verdict

No **Critical** issue. One **High** (stored XSS through the print title) found and fixed with tests; the lint gate — which
should have caught several of the style-class items — was silently disabled and is now partly restored with the
remaining gaps written down and measured.
