from kit import *

# ---------------------------------------------------------------- 01 process flow
img, d = new_canvas(1440, 620)
rect(d, (0, 0, 1440, 620), fill="#ffffff", radius=0)
text(d, (60, 54), "ManuFlow ka workflow — ek order se paisa aane tak", size=30, bold=True)
text(d, (60, 96), "Har box ek screen hai. Left se right chalein — yahi natural order hai.", size=15, color=MUTED)

steps = [
    ("Enquiry", "Customer kya\nchahata hai"),
    ("Quotation", "Rate + terms\nbhejna"),
    ("Sales Order", "Order confirm\n(SO)"),
    ("Work Order", "Kya banana\nhai (WO)"),
    ("Material Issue", "Kachcha maal\nstock se nikalna"),
    ("Production Entry", "Banaya hua maal\nFG stock me"),
    ("QC Inspection", "Quality check\n+ certificate"),
    ("Delivery Challan", "Maal bhejna\n(delivery)"),
    ("Sales Invoice", "GST bill\n+ e-invoice"),
    ("Payment In", "Paisa aaya\n(receipt)"),
]
x, y = 56, 200
bw, bh, gap = 118, 118, 26
for i, (title, sub) in enumerate(steps):
    col = PRIMARY if i < 5 else PRIMARY_DARK
    rect(d, (x, y, x + bw, y + bh), fill="#ffffff", outline=col, width=2, radius=14)
    rect(d, (x, y, x + bw, y + 34), fill=col, radius=14)
    rect(d, (x, y + 22, x + bw, y + 34), fill=col, radius=0)
    text(d, (x + bw / 2, y + 17), title, size=12, bold=True, color="#ffffff", anchor="mm")
    lines = sub.split("\n")
    for li, line in enumerate(lines):
        text(d, (x + bw / 2, y + 62 + li * 18), line, size=10.5, color="#334155", anchor="mm")
    if i < len(steps) - 1:
        ax = x + bw
        d.line((ax + 3, y + bh / 2, ax + gap - 6, y + bh / 2), fill="#94a3b8", width=2)
        d.polygon([(ax + gap - 6, y + bh / 2), (ax + gap - 14, y + bh / 2 - 5),
                   (ax + gap - 14, y + bh / 2 + 5)], fill="#94a3b8")
    x += bw + gap
    if i == 4:
        x = 56
        y = 380

text(d, (56, 348), "Paisa + maal — dono ka hisaab", size=13, bold=True, color=PRIMARY)
text(d, (56, 520), "Har step par stock aur ledger apne aap update hota hai — isliye double entry ki zaroorat nahi.",
     size=13, color=MUTED)
save(img, "01-flow.png")

# ---------------------------------------------------------------- 02 login
img, d = new_canvas(1440, 900)
rect(d, (0, 0, 1440, 900), fill="#ffffff", radius=0)
rect(d, (0, 0, 640, 900), fill=PRIMARY, radius=0)
text(d, (64, 96), "ManuFlow ERP", size=30, bold=True, color="#ffffff")
text(d, (64, 136), "Manufacturing SaaS Suite", size=15, color="#d1fae5")
rect(d, (64, 240, 96, 272), fill="#ffffff", radius=8)
text(d, (80, 256), "M", size=17, bold=True, color=PRIMARY, anchor="mm")
text(d, (64, 320), "Order se paisa aane tak —", size=26, bold=True, color="#ffffff")
text(d, (64, 358), "ek hi jagah.", size=26, bold=True, color="#ffffff")
for i, line in enumerate(["Stock, production, GST billing aur accounts",
                          "ek hi system me. Har entry ka hisaab,",
                          "har document ka print, har party ka ledger."]):
    text(d, (64, 420 + i * 26), line, size=15, color="#d1fae5")
text(d, (64, 820), "© 2026 ManuFlow · Made for Indian manufacturers", size=12, color="#a7f3d0")

text(d, (740, 150), "Sign in", size=28, bold=True)
text(d, (740, 192), "Apna email aur password daalein", size=14, color=MUTED)
y = input_box(d, 740, 250, 420, "Email", "owner@nashilk.test")
y = input_box(d, 740, y + 34, 420, "Password", "••••••••••")
y = input_box(d, 740, y + 34, 420, "Company (tenant)", "Nashilk Precision Works  ▾")
button(d, 740, y + 34, "Sign in", w=420, h=46)
text(d, (740, y + 104), "Password bhool gaye? Company admin se reset karayein.", size=12, color=MUTED)
rect(d, (740, y + 140, 1160, y + 226), fill="#f1f5f3", outline=BORDER, radius=10)
text(d, (760, y + 162), "Pehli baar login kar rahe hain?", size=13, bold=True)
text(d, (760, y + 186), "Admin aapko email + password dega. Usi se login karein.", size=12, color=MUTED)
text(d, (760, y + 206), "Ek login = ek company ka data. Doosri company ke liye header se switch karein.", size=12, color=MUTED)

def side_callout(cy, n, label):
    d.line((1168, cy, 1186, cy), fill="#b91c1c", width=2)
    d.ellipse((1186, cy - 15, 1216, cy + 15), fill="#b91c1c", outline="#ffffff", width=3)
    text(d, (1201, cy), str(n), size=14, bold=True, color="#ffffff", anchor="mm")
    tw = text_w(label, 12, True) + 24
    rect(d, (1222, cy - 14, 1222 + tw, cy + 14), fill="#b91c1c", radius=7)
    text(d, (1234, cy), label, size=12, bold=True, color="#ffffff", anchor="lm")

side_callout(284, 1, "Email")
side_callout(372, 2, "Password")
side_callout(460, 3, "Company")
side_callout(537, 4, "Sign in")
save(img, "02-login.png")
