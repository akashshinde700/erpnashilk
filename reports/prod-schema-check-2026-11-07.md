# Production schema check — `manufacture` vs ManuFlow main `b892dfe`

Read-only (information_schema only), 2026-11-07. Production: MySQL 8.4.10-10, 54 tables. Reference: ManuFlow schema at main b892dfe (verified identical to `manuflow_local`), 66 tables. No business records were read.

## Tables only in production (not ManuFlow): 0

## ManuFlow tables missing in production: 12
- `TallyConnector`
- `TallyJob`
- `TallyJobChunk`
- `TallyMasterLink`
- `TallyPairingCode`
- `TallyRateLimit`
- `TallySourceBillAllocation`
- `TallySourceInventoryLine`
- `TallySourceMaster`
- `TallySourceVoucher`
- `TallySourceVoucherLine`
- `TallyVoucherRead`

## Differences in the 54 shared tables (columns, types, nullability, defaults, indexes, foreign keys): 0

## Production tables created on/after 2026-11-05 (a ForgeERP `db push` would show here): 54
- `AccountTxn` created 2026-11-06 05:18:16
- `AuditLog` created 2026-11-06 05:18:16
- `Bom` created 2026-11-06 05:18:16
- `BomItem` created 2026-11-06 05:18:16
- `Company` created 2026-11-06 05:18:16
- `Customer` created 2026-11-06 05:18:16
- `DeliveryChallan` created 2026-11-06 05:18:16
- `DeliveryChallanItem` created 2026-11-06 05:18:16
- `Enquiry` created 2026-11-06 05:18:16
- `EnquiryItem` created 2026-11-06 05:18:16
- `Expense` created 2026-11-06 05:18:16
- `Grn` created 2026-11-06 05:18:16
- `GrnItem` created 2026-11-06 05:18:16
- `IdempotencyKey` created 2026-11-06 05:18:16
- `Item` created 2026-11-06 05:18:17
- `ItemBatch` created 2026-11-06 05:18:17
- `ItemSerial` created 2026-11-06 05:18:17
- `Loan` created 2026-11-06 05:18:17
- `Machine` created 2026-11-06 05:18:17
- `MaterialIssue` created 2026-11-06 05:18:17
- `MaterialIssueItem` created 2026-11-06 05:18:17
- `MoneyAccount` created 2026-11-06 05:18:17
- `Notification` created 2026-11-06 05:18:17
- `NumberSeq` created 2026-11-06 05:18:17
- `Payment` created 2026-11-06 05:18:17
- `Plan` created 2026-11-06 05:18:17
- `Plant` created 2026-11-06 05:18:17
- `ProductionEntry` created 2026-11-06 05:18:17
- `PurchaseInvoice` created 2026-11-06 05:18:17
- `PurchaseInvoiceItem` created 2026-11-06 05:18:17
- `PurchaseOrder` created 2026-11-06 05:18:17
- `PurchaseOrderClosure` created 2026-11-06 05:18:17
- `PurchaseOrderItem` created 2026-11-06 05:18:17
- `PurchaseRequisition` created 2026-11-06 05:18:17
- `PurchaseRequisitionItem` created 2026-11-06 05:18:17
- `PurchaseReturn` created 2026-11-06 05:18:17
- `PurchaseReturnItem` created 2026-11-06 05:18:17
- `QcCorrection` created 2026-11-06 05:18:17
- `QcInspection` created 2026-11-06 05:18:17
- `Quotation` created 2026-11-06 05:18:17
- `QuotationItem` created 2026-11-06 05:18:17
- `SalesInvoice` created 2026-11-06 05:18:17
- `SalesInvoiceItem` created 2026-11-06 05:18:17
- `SalesOrder` created 2026-11-06 05:18:17
- `SalesOrderItem` created 2026-11-06 05:18:17
- `SalesReturn` created 2026-11-06 05:18:17
- `SalesReturnItem` created 2026-11-06 05:18:17
- `StockBalance` created 2026-11-06 05:18:17
- `StockLedger` created 2026-11-06 05:18:18
- `Supplier` created 2026-11-06 05:18:18
- `User` created 2026-11-06 05:18:18
- `UserCompanyAccess` created 2026-11-06 05:18:18
- `Warehouse` created 2026-11-06 05:18:18
- `WorkOrder` created 2026-11-06 05:18:18

Production table creation times range: 2026-11-06 05:18:16 → 2026-11-06 05:18:18

## Row estimates (InnoDB statistics from information_schema; approximate, no records read)

About 6,600 rows in total, in 31 of the 54 tables. For example: Customer ~190, Supplier ~20, Item ~2,103,
StockLedger ~1,960, AuditLog ~228, Company ~2, User ~2. These estimates can lag right after a bulk load (for example, Plan
shows ~0), so they show that data is present, not exact counts.

## Conclusion

1. **The structure is exactly ManuFlow's.**
   - There are no ForgeERP or other foreign tables.
   - All 54 shared tables match ManuFlow main (b892dfe): columns, types, nullability, defaults, indexes and foreign keys.
   - The only difference is the 12 Tally tables of Phases B/E/F/H. They are expected, and the prepared migration creates them.
2. **The whole database was re-created on 2026-11-06 between 05:18:16 and 05:18:18 UTC (10:48 IST).**
   - That is the same minute PM2 `manuflow` was restarted, and right after the ForgeERP deploy (10:37–10:48 IST).
   - All 54 tables re-created in about 2 seconds matches a full restore from a database dump, most likely one of the
     pre-deploy dumps of that morning. A `prisma db push` would only have altered tables.
3. **Data is present** (estimates above). The restored dump decides how current it is: anything written between that
   dump and 10:48 IST is not in the database.
4. No ForgeERP `db push` is visible in the current structure; any it made were undone by the restore.

## Open questions (for the owner)

- Who deployed ForgeERP and then restored the database, and **which dump was restored** (20261106-103748, -103938
  or -104351)?
- Did anyone use ManuFlow between that dump's time and 10:48 IST on 2026-11-06? Entries from that window would be missing.
- The app folder's source files are still ForgeERP's. The next ManuFlow deploy replaces them, after deploy.py's target
  check is satisfied in an approved way.
