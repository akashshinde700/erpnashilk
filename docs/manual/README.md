# ManuFlow user guide — Hinglish (source kit)

The deliverable is **`docs/ManuFlow-User-Guide-Hinglish.docx`** — a beginner user manual in
Hinglish (Hindi + English technical words) for the ManuFlow manufacturing ERP.

This folder holds the kit that builds it, so the manual can be regenerated whenever the UI
changes.

## What is in the .docx

| Part | Content |
| --- | --- |
| Cover + reading guide | Who it is for, version, honesty note about the visuals |
| Contents + quick start | 15 chapters listed, plus a 3-step "10 minute" start |
| 1 | What an ERP is and why a factory runs one, module map, role table |
| 2–3 | Login, app shell, sidebar, header, `Ctrl + K` command palette |
| 4 | Masters: Items (list + tabbed form), Parties, Warehouses, Machines, BOM, Users |
| 5 | Sales cycle: enquiry → quotation → sales order → challan → invoice |
| 6 | Purchase cycle: requisition → PO → GRN ("Post to Stock") → bill → return |
| 7 | Stock: qty, moving-average rate, value, reorder/low-stock rows, what moves stock |
| 8 | Production: work order, material issue, production entry, QC, MRP |
| 9 | Billing and GST: invoice form, tax rule, print/PDF, e-invoice (IRN/JSON), Tally |
| 10 | Money and reports: receivables, payables, cash & bank, expenses, GST reports |
| 11 | Admin: Settings cards, users, audit log, Data & Backup, Import Center, notifications |
| 12 | Mobile/PWA: install on Android/iOS, offline behaviour (no offline queue) |
| 13–15 | Daily/weekly/monthly routine, troubleshooting table, glossary + shortcuts |

13 figures are placed next to the steps they describe, and every figure has numbered
callouts that are explained immediately below it.

## About the images (important)

The docx contains **annotated UI diagrams, not screenshots**. Every menu name, column header,
button label, badge and colour was copied from the real components
(`src/components/erp/registry.tsx`, `src/components/erp/modules/*.tsx`,
`src/lib/erp-constants.ts`, `e2e/support/store.ts`), but they are drawn with Pillow because this
documentation pass ran in a sandbox without a headless browser (Playwright/Chromium download
was blocked, so real screen capture was impossible).

The document states this plainly on its second page. Do not present these images as
screenshots. If real captures are wanted later, take them on a machine with a browser and
replace `shots/*.png` with same-named files, then rebuild — the layout expects 1440×900 (and
1240×930 for `13-mobile.png`).

## Rebuild

```bash
pip install --break-system-packages python-docx pillow   # once
cd docs/manual
python3 gen1.py && python3 gen2.py && python3 gen3.py \
  && python3 gen4.py && python3 gen5.py && python3 gen6.py   # figures -> shots/
python3 build_docx.py                                        # -> ../ManuFlow-User-Guide-Hinglish.docx
```

| File | Figures |
| --- | --- |
| `kit.py` | Shared canvas, palette (emerald `#047857`), sidebar, header, table, button, callout helpers |
| `gen1.py` | `01-flow` (order journey), `02-login` |
| `gen2.py` | `03-dashboard`, `04-palette` |
| `gen3.py` | `05-items`, `06-item-form` |
| `gen4.py` | `07-sales-orders`, `08-grn`, `09-stock` |
| `gen5.py` | `10-work-orders`, `11-invoice` |
| `gen6.py` | `12-gst`, `13-mobile` |
| `build_docx.py` | Whole document (styles, tables, note boxes, callouts, content) |

## Scope rules the manual follows

- Manufacturing only. CRM/POS/HR/marketing do not appear.
- No invented features: every action described exists in the codebase.
- Offline behaviour is described as it is — **no offline queue/replay**, nothing is saved
  offline.
- Brand colour is the repo's emerald `#047857`.
