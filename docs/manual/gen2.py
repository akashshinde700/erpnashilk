from kit import *

# ---------------------------------------------------------------- 03 dashboard
img, d = new_canvas(1440, 900)
sidebar(d, active="Dashboard", open_group="Dashboard")
header(d, "Dashboard", "Business KPIs at a glance")
X, W = 304, 1112

money = [("You'll Receive", "₹4,85,200", "3 customers se aana hai"),
         ("You'll Pay", "₹2,10,900", "suppliers ko dena hai"),
         ("Cash in Hand", "₹1,25,400", "cash & bank ledger"),
         ("Bank Balance", "₹8,42,000", "HDFC CA · 5010")]
cw = (W - 3 * 14) // 4
for i, (t, v, s) in enumerate(money):
    kpi_card(d, X + i * (cw + 14), 88, cw, 104, t, v, s)

kpis = [("Sales This Month", "₹6,42,700", "▲ 12% pichhle mahine se", SUCCESS),
        ("Purchases This Month", "₹3,18,400", "9 bills posted", INFO),
        ("Open Sales Orders", "7", "3 overdue delivery", WARN),
        ("Low Stock Items", "4", "reorder level se neeche", DANGER)]
for i, (t, v, s, tone) in enumerate(kpis):
    kpi_card(d, X + i * (cw + 14), 206, cw, 104, t, v, s, tone)

section_card(d, X, 326, int(W * 0.62), 250, "Sales Trend (6 months)", "Bar pe click karke us mahine ke invoices kholein")
bar_chart(d, X + 20, 392, int(W * 0.62) - 40, 168,
          [42, 58, 51, 66, 74, 81], ["May", "Jun", "Jul", "Aug", "Sep", "Oct"])
section_card(d, X + int(W * 0.62) + 16, 326, W - int(W * 0.62) - 16, 250,
             "Production Output", "Work orders se bana hua maal")
bar_chart(d, X + int(W * 0.62) + 36, 392, W - int(W * 0.62) - 56, 168,
          [12, 18, 15, 22], ["Jul", "Aug", "Sep", "Oct"], color=PRIMARY_DARK)

rect(d, (X, 592, X + W, 830), fill=CARD, outline=BORDER, radius=14)
text(d, (X + 20, 616), "QUICK ACTIONS", size=11, bold=True, color=MUTED)
text(d, (X + 20, 636), "Ek click me naya document — roz ka kaam yahan se shuru karein", size=11, color=MUTED)
acts = [("Sales Order", "＋"), ("Quotation", "＋"), ("Purchase Order", "＋"), ("Payment In", "＋"), ("Work Order", "＋"), ("GST Report", "▤")]
aw = (W - 40 - 5 * 12) // 6
for i, (label, ic) in enumerate(acts):
    ax = X + 20 + i * (aw + 12)
    rect(d, (ax, 662, ax + aw, 786), fill="#fbfdfc", outline=BORDER, radius=10)
    d.ellipse((ax + aw / 2 - 20, 684, ax + aw / 2 + 20, 724), fill=PRIMARY_SOFT)
    text(d, (ax + aw / 2, 704), ic, size=20, bold=True, color=PRIMARY, anchor="mm")
    text(d, (ax + aw / 2, 750), label, size=12, bold=True, color=TEXT, anchor="mm")

callout(d, 252, 96, 1)
callout(d, 1052, 32, 2)
callout(d, 1116, 222, 3)
callout(d, 620, 632, 4)
callout(d, 1388, 32, 5)
text(d, (X, 862), "Tip: Ctrl + K dabayein — kisi bhi module par seedha jump ho jayega.", size=12, color=MUTED)
save(img, "03-dashboard.png")

# ---------------------------------------------------------------- 04 command palette
img, d = new_canvas(1440, 900)
sidebar(d, active="Dashboard", open_group="Dashboard")
header(d, "Dashboard", "Business KPIs at a glance")
d.rectangle((280, 64, 1440, 900), fill=(15, 23, 42, 255))
overlay = Image.new("RGBA", (1160, 836), (15, 23, 42, 150))
img.paste(Image.alpha_composite(img.crop((280, 64, 1440, 900)).convert("RGBA"), overlay).convert("RGB"), (280, 64))
d = ImageDraw.Draw(img)
px, py, pw, ph = 470, 150, 640, 470
rect(d, (px, py, px + pw, py + ph), fill="#ffffff", outline=BORDER, radius=16)
rect(d, (px, py, px + pw, py + 62), fill="#ffffff", radius=16)
text(d, (px + 20, py + 31), "Search modules, items, customers, orders…", size=14, color=MUTED, anchor="lm")
d.line((px, py + 62, px + pw, py + 62), fill=BORDER, width=1)
text(d, (px + 20, py + 82), "MODULES", size=10, bold=True, color=MUTED)
rows = [("Sales Orders", "Sales"), ("Sales Invoices", "Sales"), ("Stock Balance", "Inventory"),
        ("Work Orders", "Manufacturing"), ("GST Reports", "Finance")]
ry = py + 100
for i, (label, group) in enumerate(rows):
    if i == 0:
        rect(d, (px + 10, ry, px + pw - 10, ry + 42), fill=PRIMARY_SOFT, radius=8)
    text(d, (px + 24, ry + 21), label, size=14, bold=True, color=TEXT, anchor="lm")
    text(d, (px + pw - 24, ry + 21), group, size=11, color=MUTED, anchor="rm")
    ry += 44
text(d, (px + 20, py + 340), "RECORDS", size=10, bold=True, color=MUTED)
text(d, (px + 24, py + 372), "SO/26-27/0001 — Precision Tools Pvt Ltd", size=13, color="#334155")
text(d, (px + 24, py + 400), "EN8 Round Bar 40mm — RM-EN8", size=13, color="#334155")
d.line((px, py + ph - 46, px + pw, py + ph - 46), fill=BORDER, width=1)
text(d, (px + 20, py + ph - 24), "↑↓ chunein     ↵ kholein     Esc band karein", size=11, color=MUTED, anchor="lm")
callout(d, 448, 190, 1)
callout(d, 448, 250, 2)
callout(d, 448, 560, 3)
save(img, "04-palette.png")
