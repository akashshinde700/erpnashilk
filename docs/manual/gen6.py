from kit import *

# ---------------------------------------------------------------- 12 GST report
img, d = new_canvas(1440, 900)
sidebar(d, active="GST Reports", open_group="Finance")
header(d, "GST Reports", "GSTR-1 / GSTR-3B ke numbers")
X, W = 304, 1112
text(d, (X, 96), "GST Reports", size=24, bold=True)
text(d, (X, 128), "Mahine ka tax — kitna lagaya, kitna input credit mila, kitna bharna hai", size=12, color=MUTED)
button(d, X + W - 340, 96, "Export Excel", w=150, primary=False)
button(d, X + W - 185, 96, "GSTR-1 JSON", w=145)

# period + tiles
rect(d, (X, 166, X + 380, 210), fill=CARD, outline=BORDER, radius=9)
text(d, (X + 16, 188), "Period:  Oct 2026  ▾        Company:  Nashilk Precision Works", size=13, color=TEXT, anchor="lm")

tiles = [("Outward taxable value", "₹6,42,700", PRIMARY), ("CGST", "₹28,920", INFO),
         ("SGST", "₹28,920", INFO), ("IGST", "₹7,200", INFO),
         ("Input tax credit", "₹21,450", SUCCESS), ("Net payable", "₹43,590", DANGER)]
tw = (W - 2 * 14) // 3
for i, (t, v, tone) in enumerate(tiles):
    x = X + (i % 3) * (tw + 14)
    y = 230 + (i // 3) * 96
    rect(d, (x, y, x + tw, y + 82), fill=CARD, outline=BORDER, radius=12)
    rect(d, (x, y, x + 4, y + 82), fill=tone, radius=2)
    text(d, (x + 20, y + 24), t, size=12, color=MUTED)
    text(d, (x + 20, y + 50), v, size=22, bold=True)

text(d, (X, 430), "GSTR-1 — OUTWARD SUPPLIES (B2B)", size=10, bold=True, color=MUTED)
table(d, X, 448, W, [("GSTIN", .20, "left"), ("Customer", .26, "left"), ("Invoice", .16, "left"),
                     ("Taxable", .14, "right"), ("CGST", .12, "right"), ("SGST", .12, "right")],
      [["27AABCP1234C1ZU", "Precision Tools Pvt Ltd", "INV/26-27/0005", "30,000.00", "2,700.00", "2,700.00"],
       ["27AADCS5555P1Z9", "Sahyadri Pumps", "INV/26-27/0003", "15,600.00", "1,404.00", "1,404.00"],
       ["29AACCD9876K1Z3", "Deccan Auto Systems", "INV/26-27/0002", "40,000.00", "—", "—"]],
      sizes=12)
text(d, (X, 630), "Inter-state customer (Deccan Auto, Karnataka) ka tax IGST me jaata hai — isliye CGST/SGST me dash hai.",
     size=12, color=MUTED)
rect(d, (X, 664, X + W, 792), fill=INFO_SOFT, outline="#c7d7fb", radius=12)
text(d, (X + 20, 690), "GST file karne se pehle", size=13, bold=True, color=INFO)
for i, line in enumerate([
    "1. Har invoice me customer ka GSTIN aur place of supply check karein.",
    "2. GSTR-1 ka JSON portal par upload karein, phir GSTR-3B me net payable dekhein.",
    "3. Purchase bills ka credit tabhi milega jab supplier ka invoice number system me daala ho.",
]):
    text(d, (X + 20, 716 + i * 22), line, size=12, color="#1e3a8a")
callout(d, 925, 188, 1)
callout(d, 630, 250, 2)
callout(d, 1398, 115, 3)
save(img, "12-gst.png")

# ---------------------------------------------------------------- 13 mobile
img, d = new_canvas(1240, 930)
rect(d, (0, 0, 1240, 930), fill="#ffffff", radius=0)
text(d, (56, 54), "Phone par ManuFlow — drawer aur card list", size=28, bold=True)
text(d, (56, 92), "Same app, same data. Chhoti screen par menu drawer me chala jaata hai aur list cards ban jaati hai.",
     size=14, color=MUTED)

# phone 1: drawer open
x, y = 70, 150
sx, sy, ex, ey = phone(d, x, y, 390, 690)
rect(d, (sx, sy, ex, ey), fill="#e9efec", radius=36)
dw = 300
rect(d, (sx, sy, sx + dw, ey), fill="#ffffff", radius=0)
rect(d, (sx + 18, sy + 16, sx + 46, sy + 44), fill=PRIMARY, radius=8)
text(d, (sx + 32, sy + 30), "M", size=14, bold=True, color="#ffffff", anchor="mm")
text(d, (sx + 56, sy + 24), "ManuFlow ERP", size=12, bold=True)
text(d, (sx + dw - 26, sy + 30), "×", size=18, bold=True, color=MUTED, anchor="mm")
gy = sy + 70
for group, mods in [("MASTERS", ["Items", "Parties", "Warehouses"]),
                    ("SALES", ["Sales Orders", "Sales Invoices"]),
                    ("MANUFACTURING", ["Work Orders", "Production Entries"])]:
    text(d, (sx + 20, gy), group, size=9, bold=True, color=MUTED)
    gy += 20
    for m in mods:
        if m == "Items":
            rect(d, (sx + 12, gy - 2, sx + dw - 12, gy + 24), fill=PRIMARY, radius=6)
            text(d, (sx + 24, gy + 11), m, size=11, bold=True, color="#ffffff", anchor="lm")
        else:
            text(d, (sx + 24, gy + 11), m, size=11, color="#334155", anchor="lm")
        gy += 28
    gy += 8
text(d, (sx + 20, ey - 40), "Nashilk Precision Works", size=10, bold=True, color=MUTED)
text(d, (sx + 20, ey - 26), "FY 2026–27 · GSTIN 27AABCN…", size=9, color=MUTED)
text(d, (x + 195, y + 726), "1. Drawer — module chunein", size=13, bold=True, color=PRIMARY, anchor="ma")

# phone 2: card list
x2 = 620
sx2, sy2, ex2, ey2 = phone(d, x2, y, 390, 690)
rect(d, (sx2, sy2, ex2, ey2), fill=BG, radius=36)
# header
rect(d, (sx2, sy2, ex2, sy2 + 56), fill="#ffffff", radius=0)
text(d, (sx2 + 16, sy2 + 28), "☰", size=18, bold=True, color=TEXT, anchor="lm")
text(d, (sx2 + 46, sy2 + 22), "Items", size=14, bold=True)
text(d, (sx2 + 46, sy2 + 40), "Materials & finished goods", size=9, color=MUTED)
d.ellipse((ex2 - 40, sy2 + 20, ex2 - 28, sy2 + 32), outline=MUTED, width=2)
d.line((ex2 - 29, sy2 + 31, ex2 - 24, sy2 + 36), fill=MUTED, width=2)
rect(d, (sx2 + 14, sy2 + 70, ex2 - 14, sy2 + 108), fill="#ffffff", outline=BORDER, radius=8)
text(d, (sx2 + 26, sy2 + 89), "Search items…", size=11, color=MUTED, anchor="lm")
cy = sy2 + 122
cards = [("EN8 Round Bar 40mm", "RM-EN8 · Raw Material", "480 KG", "Reorder 250"),
         ("Ball Bearing 6204", "RM-BRG · Bought Out", "64 NOS", "Reorder 100"),
         ("Pump Bracket Assembly", "FG-BRK · Finished Good", "22 NOS", "Reorder 10"),
         ("Gear Oil EP-90 (1L)", "CS-LUB · Consumable", "12 LTR", "Reorder 20")]
for name, sub, qty, reorder in cards:
    rect(d, (sx2 + 14, cy, ex2 - 14, cy + 96), fill="#ffffff", outline=BORDER, radius=10)
    text(d, (sx2 + 28, cy + 22), name, size=12, bold=True)
    text(d, (sx2 + 28, cy + 42), sub, size=10, color=MUTED)
    text(d, (sx2 + 28, cy + 68), "IN STOCK", size=8, bold=True, color=MUTED)
    text(d, (sx2 + 28, cy + 82), qty, size=12, bold=True, color=SUCCESS)
    text(d, (ex2 - 34, cy + 68), "REORDER", size=8, bold=True, color=MUTED, anchor="ra")
    text(d, (ex2 - 34, cy + 82), reorder.replace("Reorder ", ""), size=12, bold=True, color=TEXT, anchor="ra")
    cy += 104
text(d, (x2 + 195, y + 726), "2. Har record ek card — tap karke kholein", size=13, bold=True, color=PRIMARY, anchor="ma")
save(img, "13-mobile.png")
