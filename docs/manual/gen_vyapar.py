"""Figures for docs/ManuFlow-Vyapar-Import-Guide-Hinglish.docx.

Same approach as the main user manual (docs/manual/README.md): the screens are drawn with Pillow
using the app's own design tokens, labels and copy (src/components/erp/modules/import-center.tsx,
src/components/erp/import-center/vyapar-backup.tsx), because this sandbox has no browser for real
screen capture. Output: docs/manual/shots-vyapar/*.png — 1440x900, one 1240x930.
"""
from kit import *

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots-vyapar")


def save2(img, name):
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, name)
    img.save(path, "PNG", optimize=True)
    print("saved", path, img.size)


def dialog(d, x, y, w, h, subtitle, hot=True):
    d.rectangle((280, 0, 1440, 900), fill="#dfe6e4")
    rect(d, (x, y, x + w, y + h), fill="#ffffff", outline=BORDER, radius=14)
    rect(d, (x + 44, y + 26, x + 78, y + 60), fill=SUCCESS_SOFT if hot else INFO_SOFT, radius=9)
    text(d, (x + 61, y + 43), "V", size=16, bold=True, color=SUCCESS if hot else INFO, anchor="mm")
    text(d, (x + 92, y + 44), "Import from a Vyapar backup", size=19, bold=True, anchor="lm")
    text(d, (x + 44, y + 78), subtitle, size=11.5, color=MUTED)
    text(d, (x + w - 26, y + 30), "×", size=22, bold=True, color=MUTED, anchor="ra")


def step_heading(d, x, y, n, title, extra=""):
    text(d, (x, y), f"Step {n} · {title}", size=14, bold=True)
    if extra:
        text(d, (x + text_w(f"Step {n} · {title}", 14, True) + 10, y + 2), extra, size=11, color=MUTED)


def checkbox(d, x, y, checked=True, size=18, color=PRIMARY):
    rect(d, (x, y, x + size, y + size), fill=color if checked else "#ffffff", outline=color if checked else BORDER, radius=4)
    if checked:
        d.line((x + 4, y + 9, x + 8, y + 13), fill="#ffffff", width=2)
        d.line((x + 8, y + 13, x + 15, y + 5), fill="#ffffff", width=2)


def stat_card(d, x, y, w, h, label, value, hint="", tone=PRIMARY):
    rect(d, (x, y, x + w, y + h), fill=CARD, outline=BORDER, radius=10)
    rect(d, (x + 1, y + 1, x + w - 1, y + 5), fill=tone, radius=3)
    text(d, (x + 16, y + 22), label, size=11, color=MUTED)
    text(d, (x + 16, y + 54), value, size=20, bold=True)
    if hint:
        text(d, (x + 16, y + 82), hint, size=9.5, color=MUTED)


def alert_box(d, x, y, w, h, title, lines, fg=INFO, bg=INFO_SOFT):
    rect(d, (x, y, x + w, y + h), fill=bg, outline=BORDER, radius=10)
    text(d, (x + 18, y + 24), title, size=12, bold=True, color=fg)
    ly = y + 48
    for line in lines:
        text(d, (x + 18, ly), "•  " + line, size=10.5, color="#334155")
        ly += 21


def field(d, x, y, w, label, value, placeholder=False):
    """Label above a select box; returns the y of the box's bottom edge."""
    text(d, (x, y), label, size=10.5, color=MUTED)
    rect(d, (x, y + 20, x + w, y + 56), fill="#ffffff", outline=BORDER, radius=8)
    text(d, (x + 12, y + 38), value, size=12, color=MUTED if placeholder else TEXT, anchor="lm")
    text(d, (x + w - 14, y + 38), "▾", size=11, color=MUTED, anchor="rm")
    return y + 56


# ------------------------------------------------------------------ v01 Import Center page
img, d = new_canvas(1440, 900)
sidebar(d, active="Import Center", open_group="Utilities")
header(d, "Import Center", "Import data from Tally, Vyapar, or Excel in a few simple steps.")
X, W = 304, 1112
text(d, (X, 96), "Import Center", size=23, bold=True)
text(d, (X, 128), "Tally, Vyapar ya Excel se apna data ManuFlow mein laayein", size=12, color=MUTED)

rect(d, (X, 158, X + 250, 196), fill="#f1f5f3", radius=9)
rect(d, (X + 4, 162, X + 122, 192), fill="#ffffff", outline=BORDER, radius=7)
text(d, (X + 63, 177), "New Import", size=12.5, bold=True, anchor="mm")
text(d, (X + 186, 177), "History", size=12.5, color=MUTED, anchor="mm")

cards = [
    ("T", "Tally", "Import business data from Tally into ManuFlow ERP.", "Import from Tally", False),
    ("V", "Vyapar", "Import customers, suppliers, items and opening stock from a Vyapar backup (.vyb) or an exported file.", "Import from Vyapar", True),
    ("X", "Excel / CSV", "Select a file and import your data in a few simple steps.", "Import from Excel / CSV", False),
]
cw, gap = 352, 22
for i, (glyph, title, desc, btn, hot) in enumerate(cards):
    cx = X + i * (cw + gap)
    rect(d, (cx, 214, cx + cw, 514), fill=CARD, outline=PRIMARY if hot else BORDER, width=2 if hot else 1, radius=14)
    rect(d, (cx + 22, 238, cx + 78, 294), fill=SUCCESS_SOFT if hot else INFO_SOFT, radius=12)
    text(d, (cx + 50, 266), glyph, size=22, bold=True, color=SUCCESS if hot else INFO, anchor="mm")
    text(d, (cx + 22, 326), title, size=18, bold=True)
    words, line, ly = desc.split(), "", 352
    for wd in words:
        trial = (line + " " + wd).strip()
        if text_w(trial, 11.5) > cw - 44:
            text(d, (cx + 22, ly), line, size=11.5, color=MUTED)
            ly += 19
            line = wd
        else:
            line = trial
    text(d, (cx + 22, ly), line, size=11.5, color=MUTED)
    button(d, cx + 22, 452, btn, primary=True, w=cw - 44)

text(d, (X, 546), "Aapka data preview tak save nahi hota. Import sirf confirm karne ke baad hota hai aur har import History mein likha jaata hai.",
     size=11.5, color=MUTED)

callout(d, 250, 297, 1)
callout(d, 1000, 236, 2)
callout(d, 1000, 470, 3)
save2(img, "v01-import-center.png")

# ------------------------------------------------------------------ v02 upload + summary
img, d = new_canvas(1440, 900)
sidebar(d, active="Import Center", open_group="Utilities")
header(d, "Import Center", "Import data from Tally, Vyapar, or Excel in a few simple steps.")
dx, dw = 300, 1100
dialog(d, dx, 20, dw, 860,
       "Read the backup Vyapar creates (.vyb) and import the company's parties, items and stock into ManuFlow.")
X2 = dx + 44
W2 = dw - 88

step_heading(d, X2, 132, 1, "Choose the backup file")
rect(d, (X2, 158, X2 + 210, 200), fill=CARD, outline=BORDER, radius=9)
text(d, (X2 + 14, 179), "Choose the .vyb / .vyp file", size=12, bold=True, anchor="lm")
rect(d, (X2 + 226, 158, X2 + 640, 200), fill="#f8faf9", outline=BORDER, radius=9)
text(d, (X2 + 240, 179), "02-11-2026_16.27.10_DEMO_TRADERS_VypBackup.vyb · 4.4 MB", size=11, anchor="lm")
button(d, X2 + 656, 158, "Read backup", primary=True, h=42)
text(d, (X2, 216), "Vyapar: Settings → Backup & Restore → Take a backup. Backup ke andar wali .vyp file bhi chalegi.",
     size=10.5, color=MUTED)

step_heading(d, X2, 256, 2, "What this backup holds")
rect(d, (X2, 282, X2 + W2, 344), fill="#f8faf9", outline=BORDER, radius=10)
text(d, (X2 + 16, 302), "DEMO TRADERS", size=14, bold=True)
name_w = text_w("DEMO TRADERS", 14, True)
pill(d, X2 + 26 + name_w, 290, "GSTIN 27ABCDE1234F1Z5", "#334155", "#eef2f1", size=10.5, h=24)
pill(d, X2 + 26 + name_w + 196, 290, "Maharashtra", "#334155", "#eef2f1", size=10.5, h=24)
text(d, (X2 + W2 - 16, 302), "DEMO_TRADERS_VypBackup.vyp", size=10, color=MUTED, anchor="ra")
text(d, (X2 + 16, 326), "Plot No. 12, Demo Industrial Area, Pune · 9000000001 · accounts@demo-traders.example",
     size=9.5, color=MUTED)

sw = (W2 - 3 * 14) / 4
stat_card(d, X2, 362, sw, 104, "Customers", "120", "90 parties with a GSTIN")
stat_card(d, X2 + (sw + 14), 362, sw, 104, "Suppliers", "15")
stat_card(d, X2 + 2 * (sw + 14), 362, sw, 104, "Items", "1,512", "150 services · 2 with a code")
stat_card(d, X2 + 3 * (sw + 14), 362, sw, 104, "Stock on hand", "₹1,25,40,000", "1,180 items · 45,600 units")

rect(d, (X2, 482, X2 + W2, 522), fill="#f8faf9", outline=BORDER, radius=10)
text(d, (X2 + 16, 502), "▸  Vouchers read (not imported yet) — 640 entries", size=11.5, bold=True, anchor="lm")

alert_box(d, X2, 538, W2, 140, "Before you import", [
    "140 items have no GST rate in Vyapar — choose a rate for them before importing.",
    "180 items use a unit ManuFlow does not have: PACKS (20), PAIRS (6), FOOT (4), BAGS (1)…",
    "2 parties have a phone number that is not a 10-digit Indian number — imported without a phone.",
    "Vouchers (sales, purchases, payments, expenses) are read for the summary only — not imported yet.",
])
text(d, (X2, 700), "Company ka naam aur GSTIN mila kar hi aage badhein — galti se doosri company ka backup na chala jaaye.",
     size=10.5, color=WARN)

callout(d, dx + 22, 179, 1)
callout(d, dx + 22, 313, 2)
callout(d, dx + 22, 414, 3)
callout(d, dx + 22, 502, 4)
callout(d, dx + 22, 608, 5)
save2(img, "v02-upload.png")

# ------------------------------------------------------------------ v03 choose what to import
img, d = new_canvas(1440, 900)
sidebar(d, active="Import Center", open_group="Utilities")
header(d, "Import Center", "Import data from Tally, Vyapar, or Excel in a few simple steps.")
dialog(d, dx, 20, dw, 860, "Backup padh liya — ab decide karein kya import karna hai aur jo fields Vyapar mein khaali hain wo bharein.")
X2 = dx + 44
W2 = dw - 88

step_heading(d, X2, 132, 3, "What should be imported")
opts = [("Customers", "120", "Name, GSTIN, phone, address", "Vyapar parties (customers)", True),
        ("Suppliers", "15", "Name, GSTIN, phone, address", "Vyapar parties (suppliers)", True),
        ("Items", "1,512", "Name, code, HSN, GST rate, unit, prices", "Vyapar items", True),
        ("Opening stock", "1,180", "Quantity and value on hand, posted at the go-live date", "Vyapar current stock", False)]
ow, oh = (W2 - 14) / 2, 92
for i, (label, count, hint, src, checked) in enumerate(opts):
    ox = X2 + (i % 2) * (ow + 14)
    oy = 160 + (i // 2) * (oh + 12)
    rect(d, (ox, oy, ox + ow, oy + oh), fill="#f8faf9", outline=BORDER, radius=10)
    checkbox(d, ox + 16, oy + 18, checked)
    text(d, (ox + 46, oy + 26), label, size=13.5, bold=True)
    pill(d, ox + 56 + text_w(label, 13.5, True), oy + 12, count, "#334155", "#eef2f1", size=10.5, h=22)
    text(d, (ox + 46, oy + 50), hint, size=10, color=MUTED)
    text(d, (ox + 46, oy + 68), "from " + src, size=10, color=MUTED)

# items gaps panel
text(d, (X2, 388), "Items ke liye gaps bharein (Vyapar mein ye fields khaali hain):", size=11, color=MUTED)
rect(d, (X2, 406, X2 + W2, 536), fill="#ffffff", outline=BORDER, radius=10)
fw = (W2 - 64) / 3
field(d, X2 + 16, 424, fw, "Item type for products", "Raw Material")
field(d, X2 + 24 + fw, 424, fw, "GST rate for 140 items without one", "18%")
field(d, X2 + 32 + 2 * fw, 424, fw, "Unit for units ManuFlow does not have", "NOS")
text(d, (X2 + 16, 500), "Units without an equivalent: PACKS (20), PAIRS (6), FOOT (4), BAGS (1), (no unit) (149)",
     size=9.5, color=MUTED)
text(d, (X2 + 16, 518), "210 items have no HSN in Vyapar — GST invoice banane se pehle HSN bhar dein.",
     size=9.5, color=MUTED)

# opening stock panel
rect(d, (X2, 554, X2 + W2, 776), fill="#ffffff", outline=BORDER, radius=10)
text(d, (X2 + 16, 578), "Opening stock (tick kiya to):", size=11.5, bold=True)
field(d, X2 + 16, 604, 300, "Warehouse for the opening stock", "MAIN — Main Store")
text(d, (X2 + 16, 678), "Vyapar stock value ₹1,25,40,000.00 hi opening", size=9.5, color=MUTED)
text(d, (X2 + 16, 696), "value banti hai (rate = value ÷ quantity).", size=9.5, color=MUTED)

rect(d, (X2 + 344, 578, X2 + W2 - 16, 754), fill="#f1f7f4", outline=BORDER, radius=10)
text(d, (X2 + 362, 604), "Go-live date", size=11.5, bold=True, color=PRIMARY_DARK)
text(d, (X2 + 470, 604), "= aapki books ka pehla din ManuFlow mein", size=9.5, color="#334155")
rect(d, (X2 + 362, 622, X2 + 500, 654), fill="#ffffff", outline=BORDER, radius=7)
text(d, (X2 + 374, 638), "2026-04-01", size=11, anchor="lm")
text(d, (X2 + 362, 674), "Opening stock 31-03-2026 (ek din pehle) ke rate par post hota hai,", size=9.5, color="#334155")
text(d, (X2 + 362, 690), "isliye wo purchase, profit ya GST mein nahi ginta. Vyapar ka", size=9.5, color="#334155")
text(d, (X2 + 362, 706), "closing stock isi date par ManuFlow ka opening stock ban jaata hai.", size=9.5, color="#334155")
text(d, (X2 + 362, 728), "Date badalna ho to sirf go-live date badlein — import dobara karna hoga.", size=9, color=WARN)

callout(d, dx + 22, 206, 1)
callout(d, dx + 22, 306, 2)
callout(d, dx + 22, 462, 3)
callout(d, dx + 22, 638, 4)
callout(d, dx + 22, 700, 5)
save2(img, "v03-choose.png")

# ------------------------------------------------------------------ v04 review
img, d = new_canvas(1440, 900)
sidebar(d, active="Import Center", open_group="Utilities")
header(d, "Import Center", "Import data from Tally, Vyapar, or Excel in a few simple steps.")
dialog(d, dx, 20, dw, 860, "Is step tak kuch bhi save nahi hua — Import dabane par hi data likha jaata hai.")
X2 = dx + 44
W2 = dw - 88

step_heading(d, X2, 132, 4, "Review and import")
rows = [["Customers", "120", "120", "0", "0"], ["Suppliers", "15", "15", "0", "0"],
        ["Items", "1,512", "1,512", "0", "0"], ["Opening stock", "1,180", "1,180", "0", "0"]]
tbottom = table(d, X2, 158, W2, [("Data", .34, "left"), ("Records", .16, "right"), ("Ready", .16, "right"),
                                ("Duplicates", .17, "right"), ("Problems", .17, "right")], rows, row_h=40, head_h=38)
text(d, (X2, tbottom + 14), "Sabhi rows Ready hain · koi problem nahi · preview ne kuch save nahi kiya",
     size=10.5, color=SUCCESS)

p_top = tbottom + 44
rect(d, (X2, p_top, X2 + W2, p_top + 250), fill="#fdf6dd", outline=BORDER, radius=10)
text(d, (X2 + 16, p_top + 26), "Agar problems dikhein (example):", size=11.5, bold=True, color=WARN)
probs = [("Record 41", "MS BOLT M8 (EXAMPLE)", "Unit \"PACKS\" is not one of NOS, PCS, KG…"),
         ("Record 77", "HEX NUT M10 (EXAMPLE)", "GST rate is blank — enter the rate"),
         ("Record 118", "BEARING 6205 (EXAMPLE)", "Duplicate name — skipped (ManuFlow mein pehle se hai)")]
py = p_top + 56
for rec, name, msg in probs:
    text(d, (X2 + 16, py), rec, size=10.5, bold=True)
    text(d, (X2 + 100, py), name, size=10.5, bold=True, color="#334155")
    text(d, (X2 + 16, py + 18), msg, size=9.5, color="#475569")
    py += 46
button(d, X2 + 16, p_top + 206, "Download the problem rows", primary=False, h=34, size=12)

btn_y = p_top + 288
button(d, X2, btn_y, "Import 2,827 records", primary=True, h=46, icon="✓")
button(d, X2 + 250, btn_y, "Change the selection", primary=False, h=46)
text(d, (X2 + 500, btn_y + 16), "Duplicates skip honge, problem rows import nahi honge — History mein sab likha jaayega.",
     size=9.5, color=MUTED)

callout(d, dx + 22, 218, 1)
callout(d, dx + 22, p_top + 70, 2)
callout(d, dx + 22, btn_y + 22, 3)
save2(img, "v04-review.png")

# ------------------------------------------------------------------ v05 result + history
img, d = new_canvas(1440, 900)
sidebar(d, active="Import Center", open_group="Utilities")
header(d, "Import Center", "Import data from Tally, Vyapar, or Excel in a few simple steps.")
dx2, dw2 = 300, 1100
d.rectangle((280, 0, 1440, 900), fill="#dfe6e4")
rect(d, (dx2, 20, dx2 + dw2, 330), fill="#ffffff", outline=BORDER, radius=14)
rect(d, (dx2 + 44, 46, dx2 + 78, 80), fill=SUCCESS_SOFT, radius=9)
text(d, (dx2 + 61, 63), "V", size=16, bold=True, color=SUCCESS, anchor="mm")
text(d, (dx2 + 92, 64), "Import from a Vyapar backup", size=19, bold=True, anchor="lm")
text(d, (dx2 + dw2 - 26, 50), "×", size=22, bold=True, color=MUTED, anchor="ra")

X3 = dx2 + 44
rect(d, (X3, 100, X3 + dw2 - 88, 220), fill=SUCCESS_SOFT, outline=BORDER, radius=10)
text(d, (X3 + 18, 126), "✓  Import finished", size=13, bold=True, color=SUCCESS)
text(d, (X3 + 18, 154), "2,827 records imported · 0 skipped (already exist) · 0 not imported.", size=11.5)
text(d, (X3 + 18, 178), "Every batch is recorded in the Import History.", size=11.5)
text(d, (X3 + 18, 200), "Not imported: Vyapar vouchers, party balances, cash / bank opening balances.", size=9.5, color=MUTED)
button(d, X3, 244, "Close", primary=True, h=40)

text(d, (X, 380), "Import Center → History tab", size=14, bold=True)
table(d, X, 406, W, [("Date", .16, "left"), ("Type", .18, "left"), ("Details", .66, "left")], [
    ["02-11 16:40", "Items", "From Vyapar backup of \"DEMO TRADERS\", batch 4 of 4: 12 imported, 0 skipped, 0 failed"],
    ["02-11 16:38", "Opening stock", "Reference OSI-20261102163812-A1B2C3 · go-live 2026-04-01 · source qty 45,600.00, value 1,25,40,000.00"],
    ["02-11 16:36", "Customers", "From Vyapar backup of \"DEMO TRADERS\", batch 1 of 1: 120 imported, 0 skipped, 0 failed"],
], row_h=52)
text(d, (X, 406 + 38 + 52 * 3 + 26), "Har batch ka apna entry — kis file se, kitne imported / skipped / failed aur problem rows.",
     size=11, color=MUTED)

callout(d, dx2 + 22, 160, 1)
callout(d, 286, 470, 2)
save2(img, "v05-done.png")

# ------------------------------------------------------------------ v06 Vyapar app: backup
img, d = new_canvas(1240, 930)
d.rectangle((0, 0, 1240, 930), fill=BG)
text(d, (60, 56), "Vyapar app se backup kaise lein", size=26, bold=True)
text(d, (60, 92), "Ye screen Vyapar app ki hai (representative) — ManuFlow ki nahi.", size=12.5, color=MUTED)

px, py, pw = 90, 150, 340
sx0, sy0, sx1, sy1 = phone(d, px, py, pw, 740)
text(d, (sx0 + 24, sy0 + 30), "Settings", size=17, bold=True)
items = ["Firm & Settings", "Taxes & GST", "Backup & Restore", "Import / Export data", "Users & Permissions", "About Vyapar"]
iy = sy0 + 66
for it in items:
    hot = it == "Backup & Restore"
    rect(d, (sx0 + 16, iy, sx1 - 16, iy + 46), fill=SUCCESS_SOFT if hot else "#ffffff", outline=BORDER, radius=9)
    text(d, (sx0 + 32, iy + 23), it, size=12.5, bold=hot, anchor="lm")
    if hot:
        text(d, (sx1 - 32, iy + 23), "›", size=16, bold=True, color=SUCCESS, anchor="rm")
    iy += 54

bx = 500
text(d, (bx, 170), "Settings → Backup & Restore", size=15, bold=True)
sub = ["Take a backup — poora company data ek .vyb file mein",
       "File phone ke Downloads / Drive mein save hoti hai",
       "Wahi .vyb file ManuFlow ke Import Center mein upload karni hai",
       "Backup ke andar .vyp database hoti hai — wo bhi chalegi",
       "Backup lene se pehle Vyapar mein latest entry save kar lein"]
sy = 210
for i, s in enumerate(sub, 1):
    d.ellipse((bx, sy - 11, bx + 22, sy + 11), fill=PRIMARY)
    text(d, (bx + 11, sy), str(i), size=10, bold=True, color="#ffffff", anchor="mm")
    text(d, (bx + 36, sy), s, size=12, anchor="lm")
    sy += 36

rect(d, (bx, 410, 1180, 578), fill="#ffffff", outline=BORDER, radius=12)
text(d, (bx + 20, 436), "Udaharan backup (banaya hua example)", size=12.5, bold=True, color=PRIMARY_DARK)
text(d, (bx + 20, 464), "02-11-2026_16.27.10_DEMO_TRADERS_VypBackup.vyb", size=12)
text(d, (bx + 20, 490), "→  DEMO TRADERS · GSTIN 27ABCDE1234F1Z5 · Maharashtra", size=11, color=MUTED)
text(d, (bx + 20, 514), "→  120 customers · 15 suppliers · 1,512 items · stock ₹1,25,40,000.00", size=11, color=MUTED)
text(d, (bx + 20, 538), "→  640 vouchers (1 Apr 2026 – 31 Oct 2026) — abhi import nahi hote", size=11, color=MUTED)

rect(d, (bx, 600, 1180, 730), fill=INFO_SOFT, outline=BORDER, radius=12)
text(d, (bx + 20, 626), "Backup na mile to?", size=12, bold=True, color=INFO)
text(d, (bx + 20, 654), "Vyapar ke party / item / stock report ko Excel mein export karein aur", size=11, color="#334155")
text(d, (bx + 20, 678), "Import Center → Excel / CSV se import karein (2 MB, 500 rows per file).", size=11, color="#334155")
text(d, (bx + 20, 702), "Tally use karne wale customer ke liye Tally card + connector hai.", size=11, color="#334155")

save2(img, "v06-vyapar-backup.png")
