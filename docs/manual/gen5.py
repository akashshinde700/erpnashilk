from kit import *

STATUS = {
    "COMPLETED": (SUCCESS, SUCCESS_SOFT), "IN_PROGRESS": (INFO, INFO_SOFT), "RELEASED": (SUCCESS, SUCCESS_SOFT),
    "DRAFT": (MUTED, "#eef2f1"), "HIGH": (WARN, WARN_SOFT), "NORMAL": (MUTED, "#eef2f1"),
}

# ---------------------------------------------------------------- 10 work orders
img, d = new_canvas(1440, 900)
sidebar(d, active="Work Orders", open_group="Manufacturing")
header(d, "Work Orders", "Plan, release and track production orders")
X, W = 304, 1112
text(d, (X, 96), "Work Orders", size=24, bold=True)
text(d, (X, 128), "Plan, release and track production orders", size=12, color=MUTED)
button(d, X + W - 190, 96, "Work Order", w=190, icon="+")

stats = [("PLANNED", "3", "Awaiting release"), ("IN PROGRESS", "2", "Released / running"),
         ("COMPLETED", "1", "Finished orders"), ("TOTAL PLANNED QTY", "260 NOS", "Across all WOs")]
cw = (W - 3 * 12) / 4
for i, (label, val, sub) in enumerate(stats):
    cx = X + i * (cw + 12)
    rect(d, (cx, 160, cx + cw, 236), fill=CARD, outline=BORDER, radius=12)
    text(d, (cx + 18, 184), label, size=10, bold=True, color=MUTED)
    text(d, (cx + 18, 208), val, size=19, bold=True)
    text(d, (cx + 18, 226), sub, size=11, color=MUTED)

rows = [["WO/26-27/0001", "Pump Bracket Assembly", "50", "50 / 0", "12 Oct", "HIGH", "COMPLETED"],
        ["WO/26-27/0002", "Belt Tensioner 12in", "100", "60 / 2", "25 Oct", "NORMAL", "IN PROGRESS"],
        ["WO/26-27/0003", "Centrifugal Pump Body", "20", "0 / 0", "02 Nov", "HIGH", "RELEASED"],
        ["WO/26-27/0004", "Pump Bracket Assembly", "30", "12 / 0", "08 Nov", "NORMAL", "IN PROGRESS"]]
table(d, X, 256, W, [("WO #", .18, "left"), ("Item", .26, "left"), ("Planned", .11, "right"),
                     ("Prod / Rej", .13, "right"), ("Due", .12, "left"), ("Priority", .10, "left"),
                     ("Status", .10, "left")],
      rows, badges={(0, 6): ("COMPLETED", SUCCESS, SUCCESS_SOFT), (1, 6): ("IN PROGRESS", INFO, INFO_SOFT),
                    (2, 6): ("RELEASED", SUCCESS, SUCCESS_SOFT), (3, 6): ("IN PROGRESS", INFO, INFO_SOFT),
                    (0, 5): ("HIGH", WARN, WARN_SOFT), (1, 5): ("NORMAL", MUTED, "#eef2f1"),
                    (2, 5): ("HIGH", WARN, WARN_SOFT), (3, 5): ("NORMAL", MUTED, "#eef2f1")})

# ---- guide strip (clearly not a screen) 
gy = 512
text(d, (X, gy), "PRODUCTION KA SAFAR — ek order se paisa aane tak", size=11, bold=True, color=MUTED)
steps = [("Work Order", "kya banana hai, kitna, kab tak"),
         ("Material Issue", "store se material nikalta hai"),
         ("Production Entry", "bana hua + reject qty"),
         ("QC Inspection", "pass / reject certificate"),
         ("Sales Invoice", "customer ko bill")]
bw = (W - 4 * 18) / 5
for i, (t, sub) in enumerate(steps):
    bx = X + i * (bw + 18)
    rect(d, (bx, gy + 18, bx + bw, gy + 108), fill="#ffffff", outline=BORDER, radius=12)
    rect(d, (bx + 14, gy + 34, bx + 40, gy + 60), fill=PRIMARY_SOFT, radius=7)
    text(d, (bx + 27, gy + 47), str(i + 1), size=13, bold=True, color=PRIMARY_DARK, anchor="mm")
    text(d, (bx + 50, gy + 47), t, size=13, bold=True, anchor="lm")
    text(d, (bx + 16, gy + 84), sub, size=11, color=MUTED)
    if i < 4:
        ax = bx + bw
        d.line((ax + 3, gy + 63, ax + 15, gy + 63), fill="#94a3b8", width=2)
        d.polygon([(ax + 15, gy + 63), (ax + 8, gy + 59), (ax + 8, gy + 67)], fill="#94a3b8")
text(d, (X, gy + 132), "Ye 5 alag-alag screens hain. Work Order banao → Material Issue karo → Production Entry daalo → QC → bill.",
     size=12, color=MUTED)

callout(d, 1340, 152, 1)
callout(d, 1378, 200, 2)
callout(d, 1270, 277, 3)
save(img, "10-work-orders.png")

# ---------------------------------------------------------------- 11 invoice modal
img, d = new_canvas(1440, 900)
sidebar(d, active="Sales Invoices", open_group="Sales")
header(d, "Sales Invoices", "GST tax invoices")
X, W = 304, 1112
text(d, (X, 96), "Sales Invoices", size=24, bold=True)
text(d, (X, 128), "GST tax invoices", size=12, color=MUTED)
button(d, X + W - 180, 96, "Invoice", w=180, icon="+")
# faint list behind overlay
rows_bg = [["INV/26-27/0005", "30 Oct 2026", "Precision Tools Pvt Ltd", "₹59,000.00"],
           ["INV/26-27/0004", "27 Oct 2026", "Sahyadri Pumps", "₹18,408.00"],
           ["INV/26-27/0003", "22 Oct 2026", "Deccan Auto Systems", "₹47,200.00"]]
table(d, X, 170, W, [("Invoice #", .25, "left"), ("Date", .18, "left"), ("Customer", .35, "left"),
                     ("Grand Total", .22, "right")], rows_bg)
overlay = Image.new("RGBA", (1440, 900), (15, 23, 42, 110))
img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")
d = ImageDraw.Draw(img)

dx, dy, dw, dh = 390, 56, 760, 800
rect(d, (dx, dy, dx + dw, dy + dh), fill="#ffffff", outline=BORDER, radius=16)
text(d, (dx + 28, dy + 36), "Sales Invoice", size=20, bold=True)
text(d, (dx + 28, dy + 62), "From a sales order (pending qty pre-filled) or manual lines", size=12, color=MUTED)
d.line((dx, dy + 88, dx + dw, dy + 88), fill=BORDER, width=1)

# cash sale checkbox
rect(d, (dx + 28, dy + 104, dx + 44, dy + 120), fill="#ffffff", outline=BORDER, radius=4)
text(d, (dx + 54, dy + 112), "Cash Sale (walk-in)", size=13, bold=True, anchor="lm")
text(d, (dx + 190, dy + 112), "— no customer needed, paid at the counter", size=11, color=MUTED, anchor="lm")

col3 = (dw - 56 - 32) / 3
def sfield(x, y, w, label, value):
    text(d, (x, y), label, size=12, color=MUTED, anchor="ls")
    rect(d, (x, y + 8, x + w, y + 48), fill="#ffffff", outline=BORDER, radius=9)
    text(d, (x + 14, y + 28), value, size=14, color=TEXT, anchor="lm")
    text(d, (x + w - 22, y + 28), "▾", size=12, color=MUTED, anchor="mm")

ya = dy + 160
sfield(dx + 28, ya, col3, "Document type", "Tax Invoice")
sfield(dx + 28 + col3 + 16, ya, col3, "Currency", "INR — Indian Rupee")
sfield(dx + 28 + 2 * (col3 + 16), ya, col3, "Date", "31 Oct 2026")

yb = ya + 76
sfield(dx + 28, yb, 2 * col3 + 16, "Customer", "Precision Tools Pvt Ltd")
sfield(dx + 28 + 2 * (col3 + 16), yb, col3, "Due Date", "30 Nov 2026")

yc = yb + 84
text(d, (dx + 28, yc), "ITEMS", size=10, bold=True, color=MUTED)
lrows = [["Pump Bracket Assembly", "8413", "20 NOS", "1,850.00", "18%", "37,000.00"],
         ["Belt Tensioner 12in", "8483", "50 NOS", "260.00", "18%", "13,000.00"]]
table(d, dx + 28, yc + 12, dw - 56, [("Item", .34, "left"), ("HSN", .10, "left"), ("Qty", .14, "right"),
                                     ("Rate", .14, "right"), ("GST %", .10, "right"), ("Amount", .18, "right")],
      lrows, row_h=40, head_h=38, sizes=12)
text(d, (dx + 28, yc + 146), "+ Add item line", size=12, bold=True, color=PRIMARY)

# totals
ty = yc + 176
rect(d, (dx + dw - 332, ty, dx + dw - 28, ty + 170), fill="#f7faf9", outline=BORDER, radius=12)
tot_rows = [("Taxable value", "50,000.00"), ("CGST 9%", "4,500.00"), ("SGST 9%", "4,500.00")]
for i, (l, v) in enumerate(tot_rows):
    text(d, (dx + dw - 312, ty + 26 + i * 26), l, size=12, color=MUTED, anchor="lm")
    text(d, (dx + dw - 48, ty + 26 + i * 26), v, size=12, anchor="rm")
d.line((dx + dw - 312, ty + 112, dx + dw - 48, ty + 112), fill=BORDER, width=1)
text(d, (dx + dw - 312, ty + 134), "Grand Total", size=13, bold=True, anchor="lm")
text(d, (dx + dw - 48, ty + 134), "₹59,000.00", size=15, bold=True, color=PRIMARY_DARK, anchor="rm")
text(d, (dx + 28, ty + 26), "Place of supply: Maharashtra (27)", size=12, color=MUTED)
text(d, (dx + 28, ty + 50), "Intra-state → CGST + SGST", size=12, color=MUTED)

d.line((dx, dy + dh - 64, dx + dw, dy + dh - 64), fill=BORDER, width=1)
button(d, dx + dw - 270, dy + dh - 48, "Cancel", primary=False, w=110, h=38, size=13)
button(d, dx + dw - 148, dy + dh - 48, "Create Invoice", primary=True, w=130, h=38, size=13)

callout(d, dx + dw + 26, ya + 28, 1)
callout(d, dx + dw + 26, yb + 28, 2)
callout(d, dx + dw + 26, yc + 32, 3)
callout(d, dx + dw + 26, ty + 134, 4)
callout(d, dx + dw + 26, dy + dh - 30, 5)
save(img, "11-invoice.png")
