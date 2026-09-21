# Task 6-b — reports-search — Work Record

## Task
Reports Center (4 report APIs + tabbed UI) + Global search API for ManuFlow ERP.

## Files created (exactly 6)
- `src/app/api/reports/sales-by-customer/route.ts` — GET ?companyId=&from=&to= (defaults FY start Apr 1 → today); non-cancelled SalesInvoice grouped by customerId → {customerId,name,city,state,invoices,base,tax,grand,received,outstanding}, sorted grand desc + totals; native `customer` include (relation exists).
- `src/app/api/reports/purchase-by-supplier/route.ts` — same over PurchaseInvoice → {supplierId,...,paid,outstanding}; native `supplier` include.
- `src/app/api/reports/stock-valuation/route.ts` — GET ?companyId=&warehouseId?&type?; StockBalance(+item include) grouped by itemId, qty-weighted avgRate, per-item low flag, per-warehouse qty≠0 rows (warehouse JS-attach — no relation), totals {skus,value,lowStock,totalQty} + byType breakdown.
- `src/app/api/reports/profitability/route.ts` — line-level margin: taxable = SalesInvoiceItem.lineTotal (stored as taxable by sales-invoices API), cost = item.standardCost × qty (JS batch-attach; missing → 0), rows date desc limit 300, totals over full period.
- `src/app/api/search/route.ts` — GET ?companyId=&q= (min 2 chars); 7 parallel tenant-filtered findMays → case-insensitive JS lowercase matching (consistent approach; SQLite contains is case-sensitive); WO→item batch attach; round-robin merge cap 25; result shape {id,type,label,sub,module}.
- `src/components/erp/modules/reports.tsx` — ReportsModule({companyId}): shadcn Tabs ×4, shared from/to DateInput header (FY-start/today defaults) + per-tab printHtml, on-demand useList(url|null) per tab (mrp.tsx pattern), stock tab warehouse/type filters + per-type value mini-cards, DataTable with csvExport on every tab, StatCards per tab, Money/DateCell cells, LOW red badge.

## Conventions followed
- companyRequired(req) / try-catch → handleError / ok() envelope / r2() money / ApiError for bad dates.
- Date pattern copied verbatim from /api/stock-ledger (gte from; lte to with to.length<=10 → end-of-day).
- No shared files modified; no new packages; read-only endpoints (no audit rows needed).

## Verification
- `bunx eslint src/app/api/reports src/app/api/search src/components/erp/modules/reports.tsx` → 0 problems.
- `bunx tsc --noEmit` → 0 errors in my files (pre-existing errors only in examples/, mini-services/, skills/).
- Smoke (curl, Acme `cmub9qyqv000bj79o5q1jpkxl`):
  - sales-by-customer: grand ₹84,016 (>0 ✓), base 71,200 + tax 12,816 = grand ✓, outstanding 0 (PAID); date filter from=2026-09-10 → 0 rows ✓.
  - purchase-by-supplier: 0 items — both seeded PINVs are CANCELLED (2-c smoke data); filter is status != CANCELLED by design.
  - stock-valuation: value ₹12,72,480 (= /api/stock totalValue), 12 SKUs, qty 4052; RM-COPPER weighted avg 792.58 hand-verified; LOW flags FG-MOTOR5/FG-PUMP; type & warehouseId filters ✓.
  - profitability: revenue 71,200 / cost 57,600 / margin 13,600 / 19.1% ✓.
  - search: 'motor' → items + WOs (case-insensitive ✓), 'SO-' → 2 orders, 'copperfield' → supplier + 5 POs, 'INV-' → invoice, q='a' → {results:[]}; missing companyId → 400; from=notadate → 400.
  - Tenant isolation: Bharat Motors sees only BM-STATOR (₹1,86,000); 'motor' → [].
- Smoke note: dev server suffered Turbopack persistent-cache corruption mid-session (SST files wiped under .next → route 500s); recovered by rm -rf .next + dev restart; DB/data unaffected.

## Notes for orchestrator
- Registry: wire `ReportsModule` (default export) under key `'reports'` (already in ROLE_MODULE_KEYS) — Finance group fits.
- Profitability table shows ≤300 lines but totals cover the whole period (footnote rendered in UI).
- `lowStock` in stock-valuation is per ITEM across warehouses; `/api/stock` lowStockCount is per balance ROW (different metric, intentional).
- Full entry appended to worklog.md (Task ID: 6-b).
