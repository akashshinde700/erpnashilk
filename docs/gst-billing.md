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
document, and available to the returns endpoints so GSTR-1/3B can report the
supply in the reverse-charge section instead of the normal outward tables.

## Multi-currency

A document can be raised in any of the 22 supported currencies
(`src/lib/currencies.ts`). Amounts are entered in the document currency; the
**exchange rate** field records how many rupees one unit is worth, so:

* the printed invoice shows the currency symbol and an exchange-rate declaration,
* GST reports convert to INR with `toInr(amount, fxRate)`, keeping the return in
  rupees as the portal requires.

## HSN / SAC rate hints

`src/lib/gst-rates.ts` carries a curated HSN (goods) and SAC (services) → GST rate
table, ported from the reference app. `suggestGstRate(code)` matches the exact
code, then the 6-digit prefix, then the 4-digit heading, and returns
`{ rate, label }`. It is a hint only: any rate can be typed over on the line.

## Credit notes

Sales returns (`Sales → Sales Returns`, `CN/...`) stay the credit-note mechanism:
they link back to the original invoice, post the stock back in, and are reported
in GSTR-1's credit-note section.
