# CRM and POS

Two screens that close the last big gap against the ERP comparison (Mapsoft ERP sells
"Sales, POS, CRM" as one pillar; ManuFlow had the order-to-invoice half of it only).

Everything here is written from scratch against the existing models, APIs and UI kit — no
third-party code, screens or branding was copied.

| Screen | Route key | Where | What it does |
| --- | --- | --- | --- |
| CRM | `crm` | Sales → **CRM** | Leads, a stage-wise pipeline, follow-ups; winning a lead creates the customer |
| POS | `pos` | Sales → **POS** | Counter billing for walk-in customers — scan/tap items, charge, done |

---

## CRM

### Data model

`Lead` — the prospect plus the deal you expect from them.

| Field | Notes |
| --- | --- |
| `code` | `LD-0001`… allocated per company (`nextLeadCode`) |
| `name` / `companyName` / `phone` / `email` / `city` | contact details; `name` is the only required one |
| `source` | `REFERRAL`, `WEBSITE`, `EXHIBITION`, `CALL`, `WHATSAPP`, `OTHER` |
| `stage` | `NEW`, `CONTACTED`, `QUALIFIED`, `PROPOSAL`, `NEGOTIATION`, `WON`, `LOST` |
| `value` / `probability` | expected deal value and win chance (%). The stage supplies a default |
| `owner` / `expectedCloseDate` / `notes` | salesperson, forecast date, free text |
| `customerId` / `convertedAt` | set when the lead is won and the customer master is created |
| `lostReason` | only kept while the lead is `LOST` |

`LeadActivity` — a call, meeting, e-mail, WhatsApp, plant visit or a plain note hanging off a lead.
`doneAt` empty means "still to do"; that is what the pipeline card and the follow-up tab show.

Stage → default probability (`STAGE_PROBABILITY` in `src/lib/crm.ts`):
10 / 25 / 45 / 60 / 80 / 100 / 0. Moving a lead sets the probability unless the request
sends one explicitly.

### API

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/leads` | `GET` | all leads (newest first) with the **next open follow-up**, plus a `summary` |
| `/api/leads` | `POST` | create; blank code → next `LD-…` |
| `/api/leads/:id` | `GET` | one lead with all its activities |
| `/api/leads/:id` | `PATCH` | edit fields, `{action:'stage', stage}`, or `{action:'convert'}` |
| `/api/leads/:id` | `DELETE` | delete the lead and its follow-ups |
| `/api/lead-activities` | `GET` | `?open=1` → only what is still to do; `?leadId=` → one lead |
| `/api/lead-activities` | `POST` | book a follow-up (a `NOTE` is stored already done) |
| `/api/lead-activities/:id` | `PATCH` | `{done:true|false}` ticks it off / reopens it |
| `/api/lead-activities/:id` | `DELETE` | remove a follow-up |

`GET /api/leads` `summary` = `{ total, open, pipelineValue, weightedValue, won, lost, wonValue }`.
`weightedValue` is `Σ value × probability / 100` over the open stages — the forecast, not the
raw pipeline.

### Convert = customer master

`PATCH /api/leads/:id {action:'convert'}` runs in one transaction:

1. `createParty(tx, companyId, 'customer', …)` — company name (or the contact name) becomes the
   customer, phone/e-mail/city are carried over, note says `Converted from lead LD-000x`.
2. The lead becomes `WON`, probability `100`, `customerId` and `convertedAt` are set.
3. An audit row records `LD-000x converted to customer C-000x`.

Calling it twice is safe: the second call answers `created:false` / "already converted" and does
not create a duplicate customer. The same flag is set whether you convert from the lead card, the
table or by dragging the deal to `WON`.

### Screen

Three tabs:

* **Pipeline** — one column per open stage with the deal count and value, a card per lead
  (company, contact, value, next follow-up with its due date in red when overdue) and the
  per-card actions: advance to the next stage, book a follow-up, **Convert**, mark lost.
* **Leads** — the same records as a sortable table with CSV / XLSX export, search and saved views.
* **Follow-ups** — every open call/meeting/reminder, overdue ones highlighted, one click to
  mark done.

Header cards: open pipeline value, weighted forecast, won this period, leads won / lost.

### Roles

`crm` is in `ROLE_MODULE_KEYS` for **Sales Manager** and **Sales Executive** (plus the roles that
hold `*`). Reads are also allowed for anyone who can open sales invoices or enquiries, so a
dispatch user can look a lead up without being able to change one. Writes go through
`requireWrite(req, 'crm')`.

---

## POS

POS is **not** a new document type. A counter sale is an ordinary cash-sale invoice:

```
POST /api/sales-invoices {
  isCashSale: true,
  deductStock: true,
  receivedAmount: <bill total>,
  receivedMode: 'CASH' | 'UPI' | 'BANK' | 'CHEQUE',
  lines: [{ itemId, qty, rate, discountPct, gstRate, cessRate }]
}
```

So the counter sale automatically gets everything the invoice pipeline already does:

* GST split (CGST/SGST vs IGST) from the company state and the party's place of supply,
* stock deducted from the finished-goods store and an entry in the stock ledger,
* a receipt / thermal print, the same numbering series and the same audit trail,
* the sales register, GSTR-1 and the Tally / e-invoice exports — no POS-specific code there.

The walk-in customer is the existing `cashSaleCustomer()` helper; nothing is added to the
customer master for a one-off buyer.

### Screen

* Item grid with a scan box — typing a barcode/code and pressing **Enter** adds the first match,
  tapping a tile adds one piece (tapping again bumps the quantity).
* Cart with quantity steppers, rate and GST per line, taxable / tax / total at the bottom.
* Payment mode, **amount tendered** and the change due, calculated live.
* **Charge** saves the invoice, shows the invoice number and the change, clears the cart and puts
  the cursor back in the scan box for the next customer.

### Roles

`pos` is in `ROLE_MODULE_KEYS` for **Sales Manager**, **Sales Executive** and **Dispatch Manager**
(a counter clerk is usually a dispatch user). It shares the `sales-invoices` write permission, so
whoever can raise a sales invoice can bill at the counter.

---

## Testing

`e2e/specs/11-crm-pos.spec.ts` covers the pipeline card, the stage move, creating a lead, the
convert-to-customer transaction, ticking a follow-up off, and a two-line POS sale
(cart → Charge → invoice stored as `isCashSale` with the right mode) plus barcode scanning.
The fake API in `e2e/support/mock-api.ts` models the lead/activity endpoints, including
`action:'convert'` and `action:'stage'`.

## Database

Two new tables — `Lead` and `LeadActivity` — so deploying this needs one schema push:

```bash
npm run db:push     # creates Lead + LeadActivity (and the earlier GST / Tally columns)
```
