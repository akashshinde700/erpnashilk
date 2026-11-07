# Tally vouchers, Layer 1: design for review (Phase F)

Status: **design and code, tested on the test database only.** No SQL has been applied to the development database,
no voucher has been read from Tally, and nothing in ManuFlow calls this code yet.

| Piece | Where | Tests |
|---|---|---|
| Rules that need no database | `src/lib/tally/vouchers.ts` | `tests/tally-vouchers.test.ts` |
| Staging, adoption, atomic revisions, read completion | `src/lib/tally/voucher-stage.ts` | `tests/tally-voucher-stage.test.ts`, on `manuflow_local_test` |
| Voucher request | `voucherRequest()` in the connector | Built, but **not** a job; nothing runs it |

## What it is for

The voucher tables are a faithful copy of Tally's vouchers, used for reconciliation and later decisions. Writing them
**never creates or changes** ManuFlow invoices, payments, stock, Cash & Bank, balances, customers, suppliers or items.
Turning vouchers into ManuFlow documents is a separate, later design, and needs its own approval.

## Tables

| Table | Holds |
|---|---|
| `TallySourceVoucher` | One row per voucher. Unique key: (companyId, tallyCompany, **identity**). |
| `TallySourceVoucherLine` | Accounting lines of one revision. Unique key: (voucherId, revision, seq). |
| `TallySourceInventoryLine` | Inventory lines of one revision. Unique key: (voucherId, revision, seq). |
| `TallySourceBillAllocation` | Bill-wise references of one revision. Unique key: (voucherId, revision, lineSeq, seq). |
| `TallyVoucherRead` | One read of a period and its slices. Only one read runs at a time per company: `activeFor` is unique. |
| `TallyJob` + `periodFrom`, `periodTo`, `readId`, `stagedAt` | One slice of a read. |

* **Amounts:** integer paise, with Tally's sign exactly as sent. `ISDEEMEDPOSITIVE` is stored separately and never
  derived from the sign: the two disagree in some vouchers.
* **Quantities and rates:** parsed into numbers, with the original text (`10 Nos`, `100.00/Nos`) kept in `data`.
* **GST:** tax ledger lines are ordinary accounting lines; item HSN and GST details go in inventory `data`; party GSTIN
  and place of supply go in header `data`.

## 1. Identity: vouchers without a GUID

`guid` may be empty. The unique key is `identity`, built by `voucherIdentity()`, strongest first:

| Source | Identity | Survives a change of content? |
|---|---|---|
| GUID | `g:<GUID>` | yes |
| MASTERID (Tally's id for the object within the company) | `m:<MASTERID>` | yes |
| Voucher number | `n:` + SHA-256(type, number, date). No amounts are used, so the key stays the same when amounts change. | yes |
| Nothing stable | `c:` + SHA-256(type, date, party, content hash, occurrence) | no. Flagged `no_stable_identity`. |

* **Retries:** a retry produces the same identity, so it updates the same row, with no duplicate. This is tested.
* **Changed content:** the identity is unchanged for the first three sources, so the change is a new *revision* of
  the same row. This is tested.
* **Adoption** (`adoptionCandidate` in `voucher-stage.ts`): a voucher that now has a GUID or MASTERID takes over an
  earlier row stored under a weaker identity, **only when exactly one row qualifies.**

  | The voucher has | It may take over |
  |---|---|
  | A GUID | A row with **no GUID** and the **same MASTERID**. If there is none: a row with no GUID, no MASTERID, and the same type, number and date (`naturalKey`). |
  | A MASTERID only | A row with no GUID, no MASTERID, and the same `naturalKey`. |

  * Never a candidate:
    * a row that already has a (different) GUID,
    * a row with a different MASTERID,
    * a row already seen by this read or staging run (it belongs to another voucher of the read),
    * any row, when the voucher has no number (the natural key says too little).
  * **Two or more candidates:** nothing is taken over, and the voucher is stored as new with `ambiguous_match`.
  * **No candidate but a row with the same type, number and date** (for example, a GUID-less voucher whose MASTERID
    changed): stored as new with `possible_earlier_copy`, never merged silently.
  * The row taken over keeps its history and records `adoptedFrom` in `data`.
  * Gaining a GUID is not a content change: GUID, MASTERID and ALTERID are left out of the content hash.
* **Two vouchers with the same key in one read** (the same type, number and date, or the same GUID or MASTERID):
  never merged. The second is stored as `<identity>#2` with `duplicate_key_in_read`. A retry of the same read
  produces the same keys.
* **When nothing is stable:** a changed copy can't be told from a new voucher. Each read sees only its own copy, and
  the earlier copy gets `missingSince` when the read of that period completes (point 4). So a period never has two
  *active* copies, and both stay visible as history.
* **Identical vouchers within one read** are kept apart by their occurrence number, never merged.

## 2. Each revision is written atomically

The transaction boundary is in `stageVouchers()`: one `db.$transaction(async (tx) => …)` per batch of up to 50
vouchers. `writeVoucher(tx, …)` writes each voucher of the batch inside it:

1. Find the voucher row by identity, or adopt one, or insert one. Every header change is a **conditional update on
   (id, revision)**. If someone changed the row meanwhile, the update touches 0 rows, so the batch throws, rolls back,
   and is retried (up to 3 times). Inserting a duplicate identity, or meeting a deadlock, is retried the same way.
2. Compare `contentHash`:
   * **Unchanged:** update `lastSeenAt`, `jobId` and `alterId`, and clear `missingSince`. No new lines.
   * **Changed, or new:** `revision = revision + 1` and the header fields are updated. The previous revision's lines,
     inventory lines and bills get `supersededAt`. The new revision's lines, inventory lines and bills are inserted.
3. Commit. Any failure rolls back **all** of the above, so the header still points to the complete previous revision.

* **Which lines are current:** always those with `revision = header.revision`, never inferred from `supersededAt`.
* **Unique keys** on (voucherId, revision, seq) make a second, concurrent write of the same revision fail instead of
  doubling lines.
* **Batching:** vouchers are written in transactions of up to 50, so that large months stay fast. A failed batch rolls
  back whole. The slice is then not `staged`, and a retry writes it again: the content hash makes it idempotent.

**Database tests** (`tests/tally-voucher-stage.test.ts`, on the test database only):
* **Forced failure:** a CHECK constraint makes the last insert of a revision fail. The whole batch rolls back, so both
  vouchers stay on revision 1, and nothing is superseded or added.
* **Concurrency:** three concurrent stagings of the same read give 1 voucher, revision 1, and no doubled lines. Two
  concurrent different versions leave header and lines consistent, with history kept.
* **Adoption:** from MASTERID and from the natural key.
* **Not merged:**
  * two distinct vouchers with the same type, number and date, also after a retry;
  * a changed MASTERID (kept apart and flagged);
  * an ambiguous match;
  * a row that already has another GUID.
* **Tenant isolation**, and **no change to any non-Tally table**.

## 3. Line identity

* **Lines are never matched across revisions.** `seq` is a line's position *within one revision*, in the order Tally
  sent it.
* **A revision is a complete snapshot** of header, lines, inventory and bills. History is every older revision, kept
  with `supersededAt`.
* **Line order is part of the content.** If Tally reorders lines, the content hash changes and a new revision is
  written. That stores more than strictly needed, but it can never pair unrelated lines. This is tested.
* **Comparing two revisions** is done by content (ledger, amount), never by `seq`, and is labelled as a comparison,
  not an identity.

## 4. When a read is complete

A read covers a period and is split into slices: one per month (`planSlices`). A month that is too large for one
reply (too many records, or too many bytes) is split into one slice per day (`splitSlice`), without a gap or overlap.

The slice states are `pending`, `reading`, `read` (the reply was accepted), `staged` (every voucher was written),
`failed` (an error, timeout or too-large reply after retries) and `cancelled`.

**A read is complete only when** the slices cover the whole period exactly, with no gap and no overlap, **and every
slice is `staged`** (`readComplete`, tested). In every other case:

| Situation | Result |
|---|---|
| A retry of a failed slice | Re-runs that slice; the read stays running. |
| A cancelled job, or the read itself cancelled | `cancelled`, and nothing is marked |
| A timeout, a "too large" reply that can't be split further, or a staging failure | `incomplete`, and nothing is marked |
| A server restart in the middle | The read stays `running`; leases on jobs and the retry rules from Phase B apply. |

**One read at a time per ManuFlow company:** `TallyVoucherRead.activeFor` = companyId while running, and it is
unique. A second read for the same ManuFlow company is refused, whichever Tally company it names. Different ManuFlow
companies can read at the same time, even the same Tally company name; their rows never mix, because every key and
query includes companyId.

Each slice change (`updateSlice`) runs in one transaction that first locks the read row
(`SELECT id FROM TallyVoucherRead WHERE id = ? FOR UPDATE`), so two slices finishing at once cannot overwrite each
other. A slice is marked `staged` only **after** all of its vouchers were written (`stageSlice`).

**Marking missing**, in one transaction, only when the read becomes complete: vouchers of that company and Tally
company with a date in the period, `lastSeenAt` earlier than the read's start, and `missingSince` empty get
`missingSince` = now. Nothing is deleted. A later read that sees them again clears the mark.

* **A voucher whose date moved** to another month is marked in the old month and cleared when its new month is read.
* **Optional and cancelled vouchers** are kept with their flags. Reconciliation treats them separately.

## 5. Backups

* **The company backup leaves out every Tally table:** connector state, Layer 1 masters, GUID links, and all five
  voucher tables, including `TallyVoucherRead`. This is the same rule as Phases B and E: they are a copy of what is in
  Tally, plus connector secrets.
* **A company restore never touches Tally tables:**
  * Layer 1, links and voucher history stay as they were.
  * A link to a record that the restore removed is ignored.
  * Vouchers are never linked to business records in Phase F.
* **Recovery if the Tally tables themselves are lost** (for example, a lost database without a full dump):
  * The current state can be rebuilt by reading the periods from Tally again.
  * The **history cannot be rebuilt**: earlier revisions, `missingSince` dates, and vouchers already deleted in Tally.
* **Full database dumps do include all tables.** These are the predeploy `mysqldump` in `deploy.py` and the dumps
  taken before every schema change here. Keeping Layer 1 history safe therefore relies on those dumps. Whether to keep
  some of them for longer is your decision.

## The proposed read: one month of vouchers

`voucherRequest(company, from, to)` in the connector. It is **not in `JOBS`**: ManuFlow cannot request it, and nothing
runs it. In summary:

```
TALLYREQUEST = Export, TYPE = Collection, ID = ManuFlowVouchers
STATICVARIABLES: SVEXPORTFORMAT = XML, SVCURRENTCOMPANY = <company, XML-escaped>,
                 SVFROMDATE = <YYYYMMDD>, SVTODATE = <YYYYMMDD>
COLLECTION ManuFlowVouchers (ISMODIFY = No), TYPE Voucher,
  FETCH GUID, MASTERID, ALTERID, DATE, EFFECTIVEDATE, VOUCHERTYPENAME, VOUCHERNUMBER, REFERENCE,
        REFERENCEDATE, PARTYLEDGERNAME, NARRATION, ISCANCELLED, ISOPTIONAL, ISINVOICE, PLACEOFSUPPLY,
        PARTYGSTIN, GSTREGISTRATIONTYPE, ALLLEDGERENTRIES, LEDGERENTRIES, ALLINVENTORYENTRIES, INVENTORYENTRIES
  FILTER ManuFlowInPeriod:  $Date >= ##SVFromDate AND $Date <= ##SVToDate   (a read-only formula)
```

It passes the unchanged Export-only guard. The company name is escaped, and dates must be exactly `YYYYMMDD` with
from ≤ to, so they cannot change the request. All of this is tested.

**Capture plan (each step needs its own approval):**
1. Run this request once, for one company and one month, with the existing capture tool, after adding it as a capture
   option.
2. Anonymise the reply. Amounts must also be handled: either kept, after you decide, or scaled consistently.
3. Compare with Tally's Day Book for that month (count and total) and its Trial Balance movement.

## Verified, assumed, needs real voucher XML

**Verified** (real capture of masters, and tag names in a Tally-format voucher file):
* the reply layout, and reading only `BODY/DATA/COLLECTION`;
* the voucher tag names `LEDGERENTRIES.LIST`, `ALLINVENTORYENTRIES.LIST`, `ACCOUNTINGALLOCATIONS.LIST`,
  `BATCHALLOCATIONS.LIST` and `BILLALLOCATIONS.LIST`;
* that 628 of 633 sample vouchers balance only when the accounting allocations are counted;
* quantity and rate text formats;
* that the amount sign and `ISDEEMEDPOSITIVE` usually agree, but not always.

**Assumed, until a real voucher capture confirms it:**
1. That the request above returns exactly the vouchers dated in the period: `SVFROMDATE` / `SVTODATE` plus the filter.
2. That Exported vouchers carry GUID, MASTERID and ALTERID. They were empty in the sample file, which was written for
   *importing*.
3. That MASTERID stays the same when a voucher is altered.
4. That line order is stable between two reads of an unchanged voucher. If it is not, every re-read makes a needless
   revision: storage grows, but correctness is unaffected.
5. Where GST tax amounts and rates appear, and whether `ALLLEDGERENTRIES` / `ALLINVENTORYENTRIES` or
   `LEDGERENTRIES` / `INVENTORYENTRIES` is the one filled in for each voucher kind.
6. The bill fields (`BILLTYPE`, due date or credit period) and their formats.
7. What Tally's sign means for debit and credit, checked against the Day Book and Trial Balance.
8. Why 5 sample vouchers do not balance.
9. Foreign-currency vouchers.
10. How many vouchers fit in one reply (20,000 records, 8 MB): this decides when a month is split into days. A voucher
    is nested, so the result format and its checks also need a nested version. That code is not written yet.
