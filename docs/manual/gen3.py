from kit import *

# ---------------------------------------------------------------- 05 items list
img, d = new_canvas(1440, 900)
sidebar(d, active="Items", open_group="Masters")
header(d, "Items", "Raw materials, finished goods & consumables")
X, W = 304, 1112

text(d, (X, 96), "Items", size=24, bold=True)
text(d, (X, 128), "Materials, finished goods aur services master", size=12, color=MUTED)

# right-to-left button row so nothing is cut off
labels = [("Item", True), ("Import CSV", False), ("Print labels", False), ("Hide variants", False)]
bx = X + W
btn_pos = {}
for label, primary in labels:
    w = text_w(label, 15, True) + 44 + (22 if primary else 0)
    bx -= w
    button(d, bx, 96, label, primary=primary, w=w, icon="+" if primary else None)
    btn_pos[label] = (bx, w)
    bx -= 10
text(d, (X, -90), "",
     size=11, color=MUTED, anchor="ra")

# search row
rect(d, (X, 166, X + W, 208), fill="#ffffff", outline=BORDER, radius=9)
d.ellipse((X + 14, 178, X + 28, 192), outline=MUTED, width=2)
d.line((X + 27, 191, X + 32, 196), fill=MUTED, width=2)
text(d, (X + 42, 187), "Search items…", size=13, color=MUTED, anchor="lm")
text(d, (X + W - 360, 187), "Export CSV", size=12, bold=True, color=PRIMARY, anchor="lm")
text(d, (X + W - 250, 187), "Export Excel", size=12, bold=True, color=PRIMARY, anchor="lm")
text(d, (X + W - 136, 187), "Views ▾", size=12, bold=True, color=MUTED, anchor="lm")

rows = [
    ["RM-EN8", "EN8 Round Bar 40mm", "Raw Material", "KG", "18%", "78.00", "96.00", "480", "250"],
    ["RM-BRG", "Ball Bearing 6204", "Raw Material", "NOS", "18%", "132.00", "165.00", "64", "100"],
    ["FG-BRK", "Pump Bracket Assembly", "Finished Good", "NOS", "18%", "310.00", "455.00", "22", "10"],
    ["RM-SHF", "MS Shaft 25mm", "Raw Material", "KG", "18%", "72.00", "88.00", "180", "150"],
    ["CS-LUB", "Gear Oil EP-90 (1L)", "Consumable", "LTR", "18%", "240.00", "295.00", "12", "20"],
    ["FG-BLT", "Belt Tensioner 12in", "Finished Good", "NOS", "18%", "180.00", "260.00", "9", "15"],
    ["RM-BLT", "Hex Bolt M8 x 40", "Raw Material", "NOS", "18%", "4.50", "6.20", "2,400", "1,000"],
    ["FG-PMP", "Centrifugal Pump Body", "Finished Good", "NOS", "18%", "1,240.00", "1,850.00", "6", "4"],
]
table(d, X, 224, W, [("Code", .10, "left"), ("Name", .23, "left"), ("Type", .14, "left"),
                     ("UOM", .06, "left"), ("GST %", .07, "right"), ("Purchase", .10, "right"),
                     ("Selling", .10, "right"), ("In Stock", .10, "right"), ("Reorder", .10, "right")],
      rows, highlight_rows=(4, 5))
text(d, (X, 224 + 42 + 44 * len(rows) + 26), "Showing 8 of 42 items · page 1 of 4", size=12, color=MUTED)
text(d, (X + W, 224 + 42 + 44 * len(rows) + 26), "‹ Prev    1  2  3  4    Next ›",
     size=12, bold=True, color=PRIMARY, anchor="ra")
text(d, (X, 224 + 42 + 44 * len(rows) + 56),
     "Peeli row = stock reorder level se neeche hai (Low Stock).", size=12, color=WARN)

callout(d, btn_pos["Item"][0] + 60, 152, 1)
callout(d, X + 700, 187, 2)
callout(d, X + W - 44, 187, 3)
callout(d, X + W - 200, 246, 4)
callout(d, X + 96, 224 + 42 + 44 * 5 + 22, 5)
save(img, "05-items.png")

# ---------------------------------------------------------------- 06 item form
img, d = new_canvas(1440, 900)
sidebar(d, active="Items", open_group="Masters")
header(d, "Items", "Raw materials, finished goods & consumables")
d.rectangle((280, 64, 1440, 900), fill="#e8edeb")
dx, dy, dw, dh = 420, 60, 720, 780
rect(d, (dx, dy, dx + dw, dy + dh), fill="#ffffff", outline=BORDER, radius=16)
text(d, (dx + 28, dy + 36), "Item", size=20, bold=True)
text(d, (dx + 28, dy + 62), "Add a new item to the master", size=12, color=MUTED)
d.line((dx, dy + 88, dx + dw, dy + 88), fill=BORDER, width=1)

# tabs
tabs = ["Basic", "Pricing", "Stock"]
tw = (dw - 56) / 3
for i, t in enumerate(tabs):
    tx = dx + 28 + i * tw
    rect(d, (tx, dy + 104, tx + tw - 6, dy + 140), fill=PRIMARY_SOFT if i == 0 else "#f1f5f4", radius=9)
    text(d, (tx + (tw - 6) / 2, dy + 122), t, size=14, bold=True,
         color=PRIMARY_DARK if i == 0 else MUTED, anchor="mm")

col = (dw - 56 - 24) / 2
def field(x, y, label, value, select=False):
    text(d, (x, y), label, size=12, color=MUTED, anchor="ls")
    rect(d, (x, y + 8, x + col, y + 48), fill="#ffffff", outline=BORDER, radius=9)
    text(d, (x + 14, y + 28), value, size=15, color=TEXT, anchor="lm")
    if select:
        text(d, (x + col - 22, y + 28), "▾", size=13, color=MUTED, anchor="mm")
    return y

y = dy + 178
field(dx + 28, y, "Name *", "MS Shaft 25mm")
field(dx + 28 + col + 24, y, "Code *", "RM-SHF")
y += 72
field(dx + 28, y, "Type", "Raw Material", select=True)
field(dx + 28 + col + 24, y, "Category", "Raw Material")
y += 72
field(dx + 28, y, "Brand", "Optional")
field(dx + 28 + col + 24, y, "HSN / SAC Code", "7214")
y += 72
field(dx + 28, y, "UOM (primary unit)", "KG", select=True)
field(dx + 28 + col + 24, y, "Status", "Active", select=True)
y += 66

# secondary unit box
rect(d, (dx + 28, y + 6, dx + dw - 28, y + 96), fill="#f7faf9", outline=BORDER, radius=10)
text(d, (dx + 44, y + 22), "SECONDARY UNIT (OPTIONAL)", size=10, bold=True, color=MUTED)
sl = (dw - 88 - 20) / 2
text(d, (dx + 44, y + 44), "Secondary unit", size=12, color=MUTED, anchor="ls")
rect(d, (dx + 44, y + 52, dx + 44 + sl, y + 88), fill="#ffffff", outline=BORDER, radius=8)
text(d, (dx + 56, y + 71), "BOX", size=14, color=TEXT, anchor="lm")
text(d, (dx + 64 + sl, y + 44), "Conversion (KG per BOX)", size=12, color=MUTED, anchor="ls")
rect(d, (dx + 64 + sl, y + 52, dx + 64 + sl + sl, y + 88), fill="#ffffff", outline=BORDER, radius=8)
text(d, (dx + 76 + sl, y + 71), "24", size=14, color=TEXT, anchor="lm")
y += 110

field(dx + 28, y, "Part No", "MFG-DWG-118")
text(d, (dx + 28 + col + 24, y), "Barcode", size=12, color=MUTED, anchor="ls")
rect(d, (dx + 28 + col + 24, y + 8, dx + 28 + col + 24 + col - 96, y + 48), fill="#ffffff", outline=BORDER, radius=9)
text(d, (dx + 42 + col + 24, y + 28), "8901234567890", size=15, color=TEXT, anchor="lm")
button(d, (dx + 28 + col + 24 + col - 88), y + 8, "Generate", primary=False, w=88, h=40, size=12)
y += 72
text(d, (dx + 28, y), "Description", size=12, color=MUTED, anchor="ls")
rect(d, (dx + 28, y + 6, dx + dw - 28, y + 56), fill="#ffffff", outline=BORDER, radius=9)
text(d, (dx + 42, y + 26), "Optional notes about this item", size=14, color=MUTED, anchor="lm")

d.line((dx, dy + dh - 64, dx + dw, dy + dh - 64), fill=BORDER, width=1)
button(d, dx + dw - 250, dy + dh - 48, "Cancel", primary=False, w=110, h=38, size=13)
button(d, dx + dw - 128, dy + dh - 48, "Create", primary=True, w=110, h=38, size=13)

callout(d, dx - 26, dy + 178 + 26, 1)
callout(d, dx - 26, dy + 178 + 72 + 26, 2)
callout(d, dx - 26, dy + 178 + 144 + 26, 3)
callout(d, dx + dw + 26, dy + 122, 4)
callout(d, dx + dw + 26, dy + dh - 30, 5)
save(img, "06-item-form.png")
