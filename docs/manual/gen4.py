from kit import *

STATUS = {
    "DRAFT": (MUTED, "#eef2f1"), "CONFIRMED": (INFO, INFO_SOFT), "RELEASED": (SUCCESS, SUCCESS_SOFT),
    "COMPLETED": (SUCCESS, SUCCESS_SOFT), "PENDING": (WARN, WARN_SOFT), "POSTED": (SUCCESS, SUCCESS_SOFT),
    "OVERDUE": (DANGER, DANGER_SOFT), "PARTIALLY_PAID": (WARN, WARN_SOFT), "UNPAID": (DANGER, DANGER_SOFT),
    "PAID": (SUCCESS, SUCCESS_SOFT), "CANCELLED": (DANGER, DANGER_SOFT), "IN_PROGRESS": (INFO, INFO_SOFT),
}


def list_screen(name, module, group, page_title, page_sub, buttons, cols, rows, badges=None,
                highlight=(), callouts=(), note="", actions_label="", search="Search…", lines=()):
    img, d = new_canvas(1440, 900)
    sidebar(d, active=module, open_group=group)
    header(d, module, page_sub)
    X, W = 304, 1112
    text(d, (X, 96), page_title, size=24, bold=True)
    text(d, (X, 128), page_sub, size=12, color=MUTED)
    bx = X + W
    pos = {}
    for label, primary in reversed(buttons):
        w = text_w(label, 15, True) + 44 + (22 if primary else 0)
        bx -= w
        button(d, bx, 96, label, primary=primary, w=w, icon="+" if primary else None)
        pos[label] = bx
        bx -= 10
    rect(d, (X, 166, X + W, 208), fill="#ffffff", outline=BORDER, radius=9)
    d.ellipse((X + 14, 178, X + 28, 192), outline=MUTED, width=2)
    d.line((X + 27, 191, X + 32, 196), fill=MUTED, width=2)
    text(d, (X + 42, 187), search, size=13, color=MUTED, anchor="lm")
    text(d, (X + W - 200, 187), "Export CSV", size=12, bold=True, color=PRIMARY, anchor="lm")
    text(d, (X + W - 60, 187), "Views ▾", size=12, bold=True, color=MUTED, anchor="lm")
    table(d, X, 224, W, cols, rows, badges=badges, highlight_rows=highlight)
    if note:
        text(d, (X, 224 + 42 + 44 * len(rows) + 26), note, size=12, color=MUTED)
    for (x1, y1, x2, y2) in lines:
        d.line((x1, y1, x2, y2), fill=DANGER, width=2)
    for (cx, cy, n) in callouts:
        callout(d, cx, cy, n)
    save(img, name)


# ---------------------------------------------------------------- 07 sales orders
list_screen(
    "07-sales-orders.png", "Sales Orders", "Sales", "Sales Orders",
    "Customer ke confirm order — production aur billing isi se shuru hoti hai",
    [("Sales Order", True)],
    [("SO #", .16, "left"), ("Order Date", .14, "left"), ("Customer", .28, "left"),
     ("Grand Total", .16, "right"), ("Delivery", .12, "left"), ("Status", .14, "left")],
    [["SO/26-27/0001", "01 Sep 2026", "Precision Tools Pvt Ltd", "₹59,000.00", "10 Sep", "CONFIRMED"],
     ["SO/26-27/0002", "14 Sep 2026", "Deccan Auto Systems", "₹47,200.00", "22 Sep", "RELEASED"],
     ["SO/26-27/0003", "02 Oct 2026", "Sahyadri Pumps", "₹18,408.00", "12 Oct", "DRAFT"],
     ["SO/26-27/0004", "09 Oct 2026", "Vidarbha Traders", "₹9,440.00", "18 Oct", "COMPLETED"],
     ["SO/26-27/0005", "18 Oct 2026", "Precision Tools Pvt Ltd", "₹1,18,000.00", "28 Oct", "OVERDUE"],
     ["SO/26-27/0006", "24 Oct 2026", "Sahyadri Pumps", "₹23,600.00", "02 Nov", "CONFIRMED"]],
    {(0, 5): ("CONFIRMED", INFO, INFO_SOFT), (1, 5): ("RELEASED", SUCCESS, SUCCESS_SOFT),
     (2, 5): ("DRAFT", MUTED, "#eef2f1"), (3, 5): ("COMPLETED", SUCCESS, SUCCESS_SOFT),
     (4, 5): ("OVERDUE", DANGER, DANGER_SOFT), (5, 5): ("CONFIRMED", INFO, INFO_SOFT)},
    highlight=(4,),
    note="Status ka matlab: DRAFT (abhi adhoora) → CONFIRMED (order pakka) → RELEASED (production ko bheja) → COMPLETED (sab ho gaya).",
    callouts=[(1340, 152, 1), (400, 245, 2), (1362, 552, 3)])

# ---------------------------------------------------------------- 08 GRN
list_screen(
    "08-grn.png", "GRN", "Purchase", "GRN", "Goods Receipt Note — supplier ka maal godown me aaya",
    [("GRN", True)],
    [("GRN #", .14, "left"), ("Date", .13, "left"), ("PO #", .15, "left"), ("Supplier", .24, "left"),
     ("Supplier Inv", .14, "left"), ("Status", .10, "left"), ("Actions", .10, "left")],
    [["GRN/26-27/0001", "05 Sep 2026", "PO/26-27/0001", "Bharat Steel Depot", "BSD-8891", "POSTED", "Post to Stock"],
     ["GRN/26-27/0002", "12 Sep 2026", "PO/26-27/0002", "Gujarat Bearings Co", "GBC-1123", "POSTED", "Post to Stock"],
     ["GRN/26-27/0003", "21 Sep 2026", "PO/26-27/0003", "Shree Lubricants", "SL-4410", "DRAFT", "Post to Stock"],
     ["GRN/26-27/0004", "02 Oct 2026", "PO/26-27/0001", "Bharat Steel Depot", "BSD-9021", "POSTED", "Post to Stock"],
     ["GRN/26-27/0005", "15 Oct 2026", "PO/26-27/0004", "Gujarat Bearings Co", "GBC-1188", "DRAFT", "Post to Stock"]],
    {(0, 5): ("POSTED", SUCCESS, SUCCESS_SOFT), (1, 5): ("POSTED", SUCCESS, SUCCESS_SOFT),
     (2, 5): ("DRAFT", MUTED, "#eef2f1"), (3, 5): ("POSTED", SUCCESS, SUCCESS_SOFT),
     (4, 5): ("DRAFT", MUTED, "#eef2f1")},
    note="DRAFT GRN ka stock nahi badhta. “Post to Stock” dabane par hi qty stock me judti hai aur Purchase Invoice banti hai.",
    callouts=[(1340, 152, 1), (1170, 224 + 42 + 44 * 2 + 22, 2), (440, 245, 3)])

# ---------------------------------------------------------------- 09 stock
img, d = new_canvas(1440, 900)
sidebar(d, active="Stock", open_group="Inventory")
header(d, "Stock", "On-hand balances across warehouses with moving-average valuation, batches & expiry, serial numbers")
X, W = 304, 1112
text(d, (X, 96), "Stock", size=24, bold=True)
text(d, (X, 128), "On-hand balances across warehouses with moving-average valuation, batches & expiry, serial numbers",
     size=12, color=MUTED)
# tabs
tx = X
for i, (t, active) in enumerate([("Balances", True), ("Batches & Expiry", False), ("Serial numbers", False)]):
    w = text_w(t, 13, True) + 36
    if active:
        rect(d, (tx, 158, tx + w, 192), fill="#ffffff", outline=BORDER, radius=8)
        d.line((tx + 10, 192, tx + w - 10, 192), fill=PRIMARY, width=3)
    text(d, (tx + w / 2, 175), t, size=13, bold=True, color=TEXT if active else MUTED, anchor="mm")
    tx += w + 6
# warehouse filter select
rect(d, (X, 208, X + 250, 246), fill="#ffffff", outline=BORDER, radius=9)
text(d, (X + 14, 227), "All warehouses", size=13, color=TEXT, anchor="lm")
text(d, (X + 232, 227), "▾", size=12, color=MUTED, anchor="mm")
rows = [["RM-EN8", "EN8 Round Bar 40mm", "Raw Material", "Main Store", "480 KG", "78.00", "₹37,440", "250"],
        ["RM-BRG", "Ball Bearing 6204", "Raw Material", "Main Store", "64 NOS", "132.00", "₹8,448", "100"],
        ["FG-BRK", "Pump Bracket Assembly", "Finished Good", "Finished Goods", "22 NOS", "310.00", "₹6,820", "10"],
        ["RM-SHF", "MS Shaft 25mm", "Raw Material", "Main Store", "180 KG", "72.00", "₹12,960", "150"],
        ["CS-LUB", "Gear Oil EP-90 (1L)", "Consumable", "Main Store", "12 LTR", "240.00", "₹2,880", "20"],
        ["FG-BLT", "Belt Tensioner 12in", "Finished Good", "Finished Goods", "9 NOS", "180.00", "₹1,620", "15"]]
table(d, X, 264, W, [("Code", .12, "left"), ("Item", .26, "left"), ("Type", .14, "left"),
                     ("Warehouse", .16, "left"), ("Qty", .10, "right"), ("Avg Rate", .11, "right"),
                     ("Value", .11, "right"), ("Reorder", .10, "right")],
      rows, highlight_rows=(4, 5))
note_y = 264 + 42 + 44 * len(rows) + 26
text(d, (X, note_y), "Qty = godown me kitna hai. Avg Rate = moving-average cost (har GRN par average update). Value = Qty × Avg Rate.",
     size=12, color=MUTED)
text(d, (X, note_y + 26), "Reorder se neeche jaane par row peeli (Low Stock) dikhti hai — to purchase ka sochna chahiye.",
     size=12, color=WARN)
callout(d, 726, 175, 1)
callout(d, 582, 227, 2)
callout(d, 1100, 285, 3)
callout(d, 1376, 592, 4)
save(img, "09-stock.png")
