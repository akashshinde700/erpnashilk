# GST billing

ManuFlow raises GST documents from **Sales → Sales Invoices**. The billing
options below were ported from the free GST billing app
([IamRamgarhia/Free-GST-Billing-Software](https://github.com/IamRamgarhia/Free-GST-Billing-Software), MIT).

## Document types

| Type | Number prefix | When to use |
| --- | --- | --- |
| Tax Invoice | `INV` | Normal taxable supply — CGST/SGST or IGST is charged |
| Bill of Supply | `BOS` | Exempt / nil-rated / composition supply — no tax is charged |
| Proforma Invoice | `PRO` | Quote-style document before the actual supply; not a demand for payment |

Selected in the invoice dialog under **Document type**. The print heading follows
the type, and bills of supply carry an explanatory note instead of tax columns.

## Reverse charge

Tick **Reverse charge (Sec 9(3)/9(4))** when the recipient is liable to pay GST
(for example imports of service, GTA without forward charge, or purchases from an
unregistered supplier). The flag is stored on the invoice, printed on the
document, and carried into the returns:

The flag is on **both** document dialogs — the invoice (tax payable by your buyer)
and the purchase bill (**Purchase Invoices → Discount & charges**, tax *you* pay
and then claim back).

* **GSTR-1 JSON** — the invoice is reported with `rchrg: "Y"` (it used to be
  hard-coded `"N"`), so the portal knows the buyer has to pay the tax.
* **GSTR-3B** — the tax of an outward reverse-charge invoice is kept out of
  3.1(a); it is shown on its own row with the note that the buyer pays it. An
  inward reverse-charge bill is shown as **3.1(d)** (self-assessed) and its ITC is
  still claimable, even from a supplier without a GSTIN, so it no longer lands in
  the "ineligible ITC" bucket. The self-assessed tax is added back to the net
  payable, so the credit and the liability cancel out as they do on the portal.

## Multi-currency

A document can be raised in any of the 22 supported currencies
(`src/lib/currencies.ts`). Amounts are entered in the document currency; the
**exchange rate** field records how many rupees one unit is worth, so:

* the printed invoice shows the currency symbol and an exchange-rate declaration,
* every GST return converts to INR at the invoice's own rate: **GSTR-1 JSON**
  (taxable value, tax, freight / packing and the B2CL threshold test), **GSTR-3B**
  (outward taxable value) and **GSTR-9** (Tables 4, 6 and 17). The helper is
  `fxToInr()` / `toInrAmount()` in `src/lib/gst-reports.ts`, so the three reports
  cannot drift apart. `sumInr()` does the same row-by-row for a mixed-currency
  period.

The conversion is one-way — the stored amount stays in the document currency, so
the invoice keeps printing in USD/EUR and only the return is in rupees.

## HSN / SAC rate hints

`src/lib/gst-rates.ts` carries a curated HSN (goods) and SAC (services) → GST rate
table, ported from the reference app. `suggestGstRate(code)` matches the exact
code, then the 6-digit prefix, then the 4-digit heading, and returns
`{ rate, label }`. It is a hint only: any rate can be typed over on the line.

Where it is used in the invoice dialog's line editor:

* picking (or scanning) an item whose master has **no** GST rate fills the line
  rate from its HSN/SAC;
* when the item's rate differs from the table, the GST % cell shows a small
  `HSN 8483 → 18%` link under the input — one click applies it. Hovering explains
  the code ("HSN 8483 — Transmission shafts, gears, couplings").

Nothing is applied silently: an existing line rate is never overwritten by the
suggestion.

## Credit notes

Sales returns (`Sales → Sales Returns`, `CN/...`) stay the credit-note mechanism:
they link back to the original invoice, post the stock back in, and are reported
in GSTR-1's credit-note section.

## Parties and Tally

Each customer / supplier carries an optional **Tally ledger name**
(Parties → New/Edit → Commercial). It is the account the party is posted to in
Tally and is what the Tally import file writes in `LEDGERENTRIES.LIST` and what
the **Tally masters (XML)** download creates under *Sundry Debtors*. Blank means
"use the party name", which is the old behaviour. A "Both" party keeps the name
on both sides, and the field is validated by `partyData()` in `src/lib/party.ts`
(100 characters, trimmed).
