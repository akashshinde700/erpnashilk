"""Builds docs/ManuFlow-Vyapar-Import-Guide-Hinglish.docx — a beginner guide for importing
Vyapar (and Excel/Tally) data into ManuFlow, with annotated screen visuals.

Figures come from gen_vyapar.py (docs/manual/shots-vyapar/*.png). Run:
    python3 gen_vyapar.py && python3 build_vyapar_docx.py
"""
import os
from docx import Document
from docx.shared import Pt, Cm, Inches, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

HERE = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(HERE, "shots-vyapar")
OUT = os.path.join(os.path.dirname(HERE), "ManuFlow-Vyapar-Import-Guide-Hinglish.docx")

EMERALD = RGBColor(0x04, 0x78, 0x57)
EMERALD_DARK = RGBColor(0x06, 0x5F, 0x46)
INK = RGBColor(0x0F, 0x17, 0x2A)
MUTED = RGBColor(0x64, 0x74, 0x8B)
AMBER = RGBColor(0xA1, 0x62, 0x07)
RED = RGBColor(0xB9, 0x1C, 0x1C)
BLUE = RGBColor(0x1D, 0x4E, 0xD8)
BODY_FONT = "Calibri"


# ------------------------------------------------------------------ docx helpers
def shade(cell, hex_color):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), hex_color)
    tcPr.append(shd)


def cell_margins(cell, top=120, bottom=120, left=160, right=160):
    tcPr = cell._tc.get_or_add_tcPr()
    mar = OxmlElement("w:tcMar")
    for tag, val in (("top", top), ("bottom", bottom), ("left", left), ("right", right)):
        el = OxmlElement(f"w:{tag}")
        el.set(qn("w:w"), str(val))
        el.set(qn("w:type"), "dxa")
        mar.append(el)
    tcPr.append(mar)


def no_borders(table):
    tblPr = table._tbl.tblPr
    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        el = OxmlElement(f"w:{edge}")
        el.set(qn("w:val"), "none")
        el.set(qn("w:sz"), "0")
        borders.append(el)
    tblPr.append(borders)


def table_borders(table, color="DFE6E4", size=6):
    tblPr = table._tbl.tblPr
    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        el = OxmlElement(f"w:{edge}")
        el.set(qn("w:val"), "single")
        el.set(qn("w:sz"), str(size))
        el.set(qn("w:color"), color)
        borders.append(el)
    tblPr.append(borders)


def add_page_number(paragraph):
    run = paragraph.add_run()
    fld = OxmlElement("w:fldSimple")
    fld.set(qn("w:instr"), "PAGE")
    run._r.addnext(fld)


def style_document(doc):
    st = doc.styles["Normal"]
    st.font.name = BODY_FONT
    st.font.size = Pt(10.5)
    st.font.color.rgb = INK
    st.paragraph_format.space_after = Pt(6)
    st.paragraph_format.line_spacing = 1.18
    rpr = st.element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.append(rfonts)
    for attr in ("w:ascii", "w:hAnsi", "w:cs", "w:eastAsia"):
        rfonts.set(qn(attr), BODY_FONT)
    for name, size, color, before, after in (
        ("Heading 1", 19, EMERALD, 18, 8),
        ("Heading 2", 13.5, EMERALD_DARK, 12, 4),
        ("Heading 3", 11.5, INK, 8, 3),
    ):
        h = doc.styles[name]
        h.font.name = BODY_FONT
        h.font.size = Pt(size)
        h.font.bold = True
        h.font.color.rgb = color
        h.paragraph_format.space_before = Pt(before)
        h.paragraph_format.space_after = Pt(after)
        h.paragraph_format.keep_with_next = True


def header_footer(doc):
    section = doc.sections[0]
    hdr = section.header.paragraphs[0]
    hdr.text = "ManuFlow ERP  ·  Vyapar se data import (Hinglish)"
    hdr.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    run = hdr.runs[0]
    run.font.size = Pt(8.5)
    run.font.color.rgb = MUTED
    ftr = section.footer.paragraphs[0]
    ftr.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = ftr.add_run("Page ")
    r.font.size = Pt(8.5)
    r.font.color.rgb = MUTED
    add_page_number(ftr)


def h1(doc, text, page_break=True):
    if page_break:
        doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)
    return doc.add_paragraph(text, style="Heading 1")


def h2(doc, text):
    return doc.add_paragraph(text, style="Heading 2")


def h3(doc, text):
    return doc.add_paragraph(text, style="Heading 3")


def para(doc, text, size=None, italic=False, color=None, space_after=6, bold=False):
    p = doc.add_paragraph()
    run = p.add_run(text)
    run.bold = bold
    run.italic = italic
    if size:
        run.font.size = Pt(size)
    if color:
        run.font.color.rgb = color
    p.paragraph_format.space_after = Pt(space_after)
    return p


def rich(doc, parts, space_after=6, indent=0):
    p = doc.add_paragraph()
    for text, bold in parts:
        r = p.add_run(text)
        r.bold = bold
    p.paragraph_format.space_after = Pt(space_after)
    if indent:
        p.paragraph_format.left_indent = Cm(indent)
    return p


def bullets(doc, items, indent=0.6):
    for item in items:
        if isinstance(item, tuple):
            head, rest = item
            p = doc.add_paragraph(style="List Bullet")
            r = p.add_run(head)
            r.bold = True
            p.add_run(rest)
        else:
            p = doc.add_paragraph(item, style="List Bullet")
        p.paragraph_format.left_indent = Cm(indent)
        p.paragraph_format.space_after = Pt(3)


def steps(doc, items, start=1):
    for i, item in enumerate(items, start):
        p = doc.add_paragraph()
        p.paragraph_format.left_indent = Cm(0.9)
        p.paragraph_format.first_line_indent = Cm(-0.6)
        p.paragraph_format.space_after = Pt(4)
        num = p.add_run(f"{i}.  ")
        num.bold = True
        num.font.color.rgb = EMERALD
        if isinstance(item, tuple):
            head, rest = item
            r = p.add_run(head)
            r.bold = True
            p.add_run(rest)
        else:
            p.add_run(item)


def note_box(doc, title, text, tone="tip"):
    colors = {
        "tip": ("F1F7F4", EMERALD_DARK, "TIP"),
        "warn": ("FDF6E3", AMBER, "DHYAN DEIN"),
        "danger": ("FCECEC", RED, "MAT KAREIN"),
        "info": ("EAF0FD", BLUE, "JAANKARI"),
    }
    fill, color, tag = colors[tone]
    t = doc.add_table(rows=1, cols=1)
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    no_borders(t)
    cell = t.cell(0, 0)
    shade(cell, fill)
    cell_margins(cell, top=140, bottom=140, left=200, right=200)
    p = cell.paragraphs[0]
    p.paragraph_format.space_after = Pt(2)
    r = p.add_run(f"{tag}  ·  {title}")
    r.bold = True
    r.font.size = Pt(9.5)
    r.font.color.rgb = color
    p2 = cell.add_paragraph()
    p2.paragraph_format.space_after = Pt(0)
    r2 = p2.add_run(text)
    r2.font.size = Pt(10)
    doc.add_paragraph().paragraph_format.space_after = Pt(2)


def image(doc, filename, caption, width=6.5):
    path = os.path.join(SHOTS, filename)
    doc.add_picture(path, width=Inches(width))
    doc.paragraphs[-1].alignment = WD_ALIGN_PARAGRAPH.CENTER
    cap = doc.add_paragraph()
    cap.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = cap.add_run(caption)
    r.italic = True
    r.font.size = Pt(8.5)
    r.font.color.rgb = MUTED
    cap.paragraph_format.space_after = Pt(10)


def table(doc, headers, rows, widths=None, header_fill="047857", font_size=9.5):
    t = doc.add_table(rows=1, cols=len(headers))
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    table_borders(t)
    hdr = t.rows[0].cells
    for i, h in enumerate(headers):
        shade(hdr[i], header_fill)
        cell_margins(hdr[i], top=90, bottom=90)
        p = hdr[i].paragraphs[0]
        p.paragraph_format.space_after = Pt(0)
        r = p.add_run(h)
        r.bold = True
        r.font.size = Pt(font_size)
        r.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
    for ri, row in enumerate(rows):
        cells = t.add_row().cells
        for ci, val in enumerate(row):
            cell_margins(cells[ci], top=80, bottom=80)
            if ri % 2 == 1:
                shade(cells[ci], "F7FAF9")
            p = cells[ci].paragraphs[0]
            p.paragraph_format.space_after = Pt(0)
            r = p.add_run(str(val))
            r.font.size = Pt(font_size)
            if ci == 0:
                r.bold = True
    t.autofit = False
    if widths:
        for row in t.rows:
            for i, w in enumerate(widths):
                row.cells[i].width = Cm(w)
    doc.add_paragraph().paragraph_format.space_after = Pt(2)
    return t


def figure_points(doc, items):
    """items: [(number, text)] — one line per callout in the figure above."""
    for num, text in items:
        p = doc.add_paragraph()
        p.paragraph_format.left_indent = Cm(0.9)
        p.paragraph_format.first_line_indent = Cm(-0.6)
        p.paragraph_format.space_after = Pt(2)
        r = p.add_run(f"{num}  ")
        r.bold = True
        r.font.color.rgb = EMERALD
        r2 = p.add_run(text)
        r2.font.size = Pt(10)


# =====================================================================================
doc = Document()
cp = doc.core_properties
cp.title = "ManuFlow ERP — Vyapar se data import (Hinglish)"
cp.subject = "Step-by-step import guide: Vyapar backup, Excel/CSV, Tally"
cp.author = "ManuFlow documentation"
cp.keywords = "ERP, Vyapar, import, Hinglish, backup, opening stock, GST"
cp.comments = "Screen visuals are annotated UI diagrams drawn from the real labels in the app."
style_document(doc)
header_footer(doc)
for section in doc.sections:
    section.top_margin = Cm(1.9)
    section.bottom_margin = Cm(1.8)
    section.left_margin = Cm(2.0)
    section.right_margin = Cm(2.0)

# ------------------------------------------------------------------ cover
cover = doc.add_table(rows=1, cols=1)
no_borders(cover)
cell = cover.cell(0, 0)
shade(cell, "047857")
cell_margins(cell, top=900, bottom=900, left=400, right=400)
p = cell.paragraphs[0]
p.paragraph_format.space_after = Pt(6)
r = p.add_run("ManuFlow ERP")
r.bold = True
r.font.size = Pt(36)
r.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
p2 = cell.add_paragraph()
p2.paragraph_format.space_after = Pt(18)
r2 = p2.add_run("Purana data ManuFlow mein laayein")
r2.font.size = Pt(14)
r2.font.color.rgb = RGBColor(0xD1, 0xFA, 0xE5)
p3 = cell.add_paragraph()
r3 = p3.add_run("Vyapar backup · Excel/CSV · Tally")
r3.bold = True
r3.font.size = Pt(20)
r3.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)

para(doc, "", space_after=10)
para(doc, "Ye guide kiske liye hai", size=12, bold=True, color=EMERALD)
para(doc, "Jo customer Vyapar app chhod kar ManuFlow par aa raha hai — uska data ek hi baar mein "
          "ManuFlow mein aana chahiye: customers, suppliers, items aur opening stock. Ye guide us "
          "kaam ke liye hai. Har screen ke saath image hai, image mein laal numbers hain, aur image "
          "ke neeche har number ka matlab likha hai — bas wahin se follow karte jaayein.",
     space_after=10)

meta = doc.add_table(rows=5, cols=2)
no_borders(meta)
for i, (k, v) in enumerate([
    ("Version", "1.0  (2 November 2026)"),
    ("Kis ke liye", "Admin, accountant, data-entry staff — beginner ke liye likha gaya hai"),
    ("Kitna time", "Pehli baar: 20–30 minute (backup file pehle se ho to 10 minute)"),
    ("Bhasha", "Hinglish (Hindi + English technical shabd)"),
    ("Screen images", "App ke asli labels se banaye gaye diagrams (asli photo nahi) — page 2 par detail"),
]):
    c0, c1 = meta.rows[i].cells
    r = c0.paragraphs[0].add_run(k)
    r.bold = True
    r.font.size = Pt(9.5)
    r.font.color.rgb = MUTED
    r = c1.paragraphs[0].add_run(v)
    r.font.size = Pt(9.5)
    cell_margins(c0, top=40, bottom=40, left=0, right=100)
    cell_margins(c1, top=40, bottom=40, left=0, right=0)

# ------------------------------------------------------------------ how to read
h1(doc, "Is guide ko kaise padhein")
steps(doc, [
    ("Pehle poora ek baar padh lein. ", "Chapter 1 se 7 tak Vyapar wala rasta hai — jo 90% customers ke liye chahiye."),
    ("Phir saath-saath karein. ", "Har chapter ke start mein image hai; usme laal number wahi hain jo neeche list mein hain."),
    ("Import se pehle checklist dekhein. ", "Chapter 11 ki checklist 2 minute leti hai aur badi galtiyan rok deti hai."),
    ("Kuch samajh na aaye to ", "Chapter 10 (messages) dekhein — wahin har error ka matlab aur solution hai."),
])

note_box(doc, "Images ke baare mein saaf baat",
         "Is guide ki tasveerein app ke asli buttons, menus, labels aur colours se banayi gayi hain, lekin "
         "ye computer-generated diagrams hain — asli screenshot nahi. Aapke screen par font thoda alag lag "
         "sakta hai, par button ke naam, order aur behaviour bilkul wahi hain. Jab app update ho, ye tasveerein "
         "dobara generate ki ja sakti hain (source: docs/manual/gen_vyapar.py).", tone="info")

h2(doc, "Is guide mein kya-kya hai")
table(doc, ["Chapter", "Kya milega"], [
    ["1 · Import Center", "Menu kahan hai, 3 cards, kaun-kaun kar sakta hai (roles)"],
    ["2 · Vyapar se backup", "Customer ke Vyapar app se .vyb file kaise nikaalein"],
    ["3 · Upload + summary", "File chadhaana, company verify karna, warnings padhna"],
    ["4 · Kya import karna hai", "Customers / suppliers / items / opening stock + GST, unit, item type"],
    ["5 · Preview + Import", "Data check karna, problems dekhna, Import dabana"],
    ["6 · Import ke baad", "6 checks — sab sahi gaya ya nahi"],
    ["7 · Is customer ka result", "SAI NIRMAN INDUSTRIES ke expected numbers"],
    ["8–9 · Excel/CSV · Tally", "Backup na mile to doosre raaste"],
    ["10–12", "Messages, checklist, dobara import, shabd-kosh"],
], widths=[5.0, 11.5])

# ------------------------------------------------------------------ 1 · Import Center
h1(doc, "1 · Import Center kahan hai")
para(doc, "Poora import ek hi jagah se hota hai: left sidebar mein UTILITIES → Import Center. "
          "Wahan 3 cards hain — Tally, Vyapar aur Excel / CSV. Vyapar wala card hi is guide ka main "
          "hissa hai.")

image(doc, "v01-import-center.png", "Figure 1 — Import Center ka main page, Vyapar card highlight kiya hua")

figure_points(doc, [
    (1, "Sidebar ka UTILITIES group. Usme Import Center par click karein. (Na mile to aapke user ke paas "
        "Import Center ki permission nahi hai — admin se kahein.)"),
    (2, "Vyapar card — is par green border hai kyunki yahi wala rasta is guide mein use hoga. Card par "
        "likha hai: customers, suppliers, items aur opening stock."),
    (3, "\"Import from Vyapar\" button — isse 4-step wala dialog khulta hai (Figure 3 se aage)."),
])

h2(doc, "Kaun kar sakta hai (roles)")
table(doc, ["Role", "Kya kar sakta hai", "Dhyan rakhein"], [
    ["Admin / Owner", "Sab kuch — import, settings, users, go-live date", "Go-live date sirf admin badal sakta hai"],
    ["Accountant", "Customers, suppliers, items, opening stock import", "Jis module par write permission nahi, "
                                                                     "uska data import nahi hoga"],
    ["Store / Data entry", "Items aur opening stock", "Vyapar backup upload kar sakta hai, par customers "
                                                      "skip ho sakte hain"],
    ["Read-only user", "Sirf dekh sakta hai", "Import button kaam nahi karega — admin se kahein"],
], widths=[3.6, 6.4, 6.5])

note_box(doc, "Sabse aham baat",
         "Import ka poora process 4 steps mein hai aur Step 4 tak kuch bhi save nahi hota. Aap file "
         "chadha kar, summary dekh kar, choices badal kar, aur preview dekh kar safalta-poorvak file chhod "
         "sakte hain — database mein kuch nahi jaata. Sirf \"Import\" button dabane par data likha jaata hai.",
         tone="tip")

# ------------------------------------------------------------------ 2 · Vyapar backup
h1(doc, "2 · Vyapar se backup file nikaalein")
para(doc, "ManuFlow ko Vyapar ki backup chahiye — wo file jiske naam ke aakhir mein .vyb hota hai. "
          "Ye file customer ke Vyapar app se nikalni hoti hai (ManuFlow ise khud nahi nikaal sakta). "
          "Agar customer khud kar sakta hai to unhe ye steps bhej dein.")

image(doc, "v06-vyapar-backup.png",
      "Figure 2 — Vyapar app mein Settings → Backup & Restore (Vyapar ka screen, ManuFlow ka nahi)",
      width=6.3)

steps(doc, [
    ("Customer ke phone/computer par Vyapar kholein ", "aur us firm mein jaayein jiska data import karna hai "
     "(ek se zyada firm ho to sahi firm chunein)."),
    ("Settings → Backup & Restore ", "par jaayein."),
    ("\"Take a backup\" dabayein. ", "Vyapar ek .vyb file banata hai — naam kuch aisa: 02-11-2026_16.27.10_"
     "<FIRM NAME>_VypBackup.vyb"),
    ("File ko WhatsApp / email / Drive se aap tak bhejein ", "ya computer par copy karein (Import Center "
     "usi computer se chalayein jahan file hai)."),
    ("Vyapar band karne ki zaroorat nahi, ", "par backup lene se pehle latest entry save kar lein — tabhi "
     "tak ka data aayega."),
], start=1)

para(doc, "Backup ke andar ek .vyp file hoti hai (Vyapar ka database). Dono chalte hain — ManuFlow .vyb "
          "(ZIP) aur seedhi .vyp file, dono padh leta hai. Agar customer ke paas sirf ek report hai "
          "(party list, item list), to Chapter 8 ka Excel/CSV rasta use karein.", size=10)

note_box(doc, "Backup file ke saath kya karein", "File ka naam na badlein aur uski copy sambhal kar rakhein — "
         "kuch din baad compare karne ke liye wahi file kaam aayegi. Backup mein customer ka poora data "
         "hota hai, isliye ye file kisi ko forward na karein.", tone="warn")

# ------------------------------------------------------------------ 3 · Upload
h1(doc, "3 · Backup upload karein (Step 1 aur 2)")
para(doc, "Import Center → Vyapar card → \"Import from Vyapar\". Neeche wala dialog khulega. Pehle file "
          "chadhaayein, phir \"Read backup\" dabayein — ManuFlow server par file padhta hai (customer ke "
          "computer par kuch install nahi hota).")

image(doc, "v02-upload.png", "Figure 3 — Step 1 (file choose) aur Step 2 (backup mein kya hai)")

figure_points(doc, [
    (1, "\"Choose the .vyb / .vyp file\" — apni backup file chunein. File ka naam aur size (jaise 4.4 MB) "
        "uske bagal mein dikh jaayega. 256 MB tak ki file chalti hai."),
    (2, "\"Read backup\" — file padhi jaati hai. 2,500 items wali file mein 10–30 second lag sakte hain. "
        "Galti hui to laal box mein reason aayega (Chapter 10)."),
    (3, "Company ka naam, GSTIN, state aur address — yahan check karein ki yahi customer hai. "
        "Doosri company ka backup chadh gaya to aage mat badhein, file dobara chunein."),
    (4, "4 numbers: kitne customers, kitne suppliers, kitne items, aur stock ki value. Inhe customer ke "
        "Vyapar se milaayein — items aur stock value match hone chahiye."),
    (5, "\"Vouchers read (not imported yet)\" — bill/payment/expense ki ginti. Ye sirf summary ke liye "
        "padhi jaati hain, import nahi hoti (Chapter 7)."),
])

h2(doc, "\"Before you import\" ke warnings ka matlab")
table(doc, ["Warning", "Matlab", "Aapko kya karna hai"], [
    ["N items have no GST rate in Vyapar", "Un items par GST rate set nahi hai", "Step 3 mein ek default "
     "rate chunein (0 / 5 / 12 / 18 / 28). Baad mein item master se badal sakte hain."],
    ["N items use a unit ManuFlow does not have", "Vyapar ki unit (PACKS, PAIRS, FOOT…) ManuFlow ki list "
     "mein nahi hai", "Step 3 mein unit chunein jismein ye convert honge (jaise NOS ya PCS)."],
    ["N parties have a phone number that is not a 10-digit…", "Vyapar mein landline/adhoora number hai",
     "Kuch karne ki zaroorat nahi — wo party phone ke bina import hoti hai, baaki data aa jaata hai."],
    ["Vouchers … not imported yet", "Purane bill/payment abhi import nahi hote", "Customer ko bata dein — ye abhi "
     "nahi aate. Opening balances go-live date par set honge."],
], widths=[4.6, 5.4, 6.5])

# ------------------------------------------------------------------ 4 · what to import
h1(doc, "4 · Kya import karna hai (Step 3)")
para(doc, "Ab ManuFlow poochta hai ki kaunsa data laana hai. Default mein sab tick hote hain. Har "
          "tick ke saath count bhi dikhta hai, taaki customer ke numbers se milaaya ja sake.")

image(doc, "v03-choose.png", "Figure 4 — Step 3: data types, gaps (GST rate / unit / item type) aur go-live date")

figure_points(doc, [
    (1, "Customers aur Suppliers — naam, GSTIN, phone, address. Duplicate naam wali party skip ho jaati "
        "hai (ManuFlow mein pehle se hai to)."),
    (2, "Items — naam, code, HSN, GST rate, unit, purchase/sale price. Opening stock alag se tick hota hai "
        "kyunki wo stock movement banata hai, master nahi."),
    (3, "Teen gaps: (a) item type — products kis type ke banenge (Raw Material / Finished Good / "
        "Consumable), (b) GST rate — jin items par rate nahi hai unke liye default, (c) unit — jo unit "
        "ManuFlow mein nahi hai unke liye default. Ye sirf khaali fields bharte hain, sahi data overwrite "
        "nahi hota."),
    (4, "Warehouse — opening stock kis store/godown mein daalna hai. Ek hi warehouse ho to \"MAIN — Main "
        "Store\" chunein."),
    (5, "Go-live date — aapki books ka pehla din ManuFlow mein. Opening stock ek din pehle ki date par "
        "post hota hai, isliye wo purchase ya profit mein nahi ginta. Date future mein nahi honi chahiye."),
])

h2(doc, "Go-live date — simple bhasha mein")
para(doc, "Maan lijiye customer 1 April 2026 se ManuFlow use karna chahta hai. To go-live date 2026-04-01 "
          "set karein. ManuFlow Vyapar ka closing stock 31-03-2026 ki date par opening stock ke roop mein "
          "daal deta hai. Isse stock report Vyapar se match karta hai aur 1 April se hone wali sales/purchase "
          "hi naye saal ke profit mein aati hain.")
note_box(doc, "Ek baar opening stock import hone ke baad go-live date lock ho jaati hai",
         "Kyunki opening stock us date par post ho chuka hota hai. Isliye date pehle soch kar set karein. "
         "Baad mein badalna ho to opening stock ki entries reverse karni padti hain — admin ka kaam hai.",
         tone="warn")

h2(doc, "Import ka order (ManuFlow khud sambhalta hai)")
steps(doc, [
    "Customers → phir Suppliers → phir Items → phir Opening stock.",
    "Opening stock items ke turant baad preview hota hai aur post kiya jaata hai, kyunki stock ke liye "
    "items ka master pehle chahiye.",
    "Har data type 500 records ke batch mein jaata hai — 2,512 items 6 batches banenge. Beech mein "
    "internet chala jaaye to jo batch gayi wo gayi, baaki dobara try karein (duplicates skip ho jaate hain).",
])

# ------------------------------------------------------------------ 5 · preview + import
h1(doc, "5 · Preview aur Import (Step 4)")
para(doc, "Step 4 mein pehle \"Check the data\" button aata hai. Wo dabane par ManuFlow har record ko "
          "check karta hai — lekin kuch save nahi karta. Neeche wali table aati hai, jismein har data type ke "
          "Records / Ready / Duplicates / Problems dikhte hain.")

image(doc, "v04-review.png", "Figure 5 — Step 4: preview table, problems ki list, aur \"Import\" button")

figure_points(doc, [
    (1, "Table ka matlab: Records = backup mein kitne; Ready = jo import ho sakte hain; Duplicates = jo "
        "pehle se ManuFlow mein hain (skip honge); Problems = jo galti ki wajah se nahi jaayenge."),
    (2, "Problems wali jagah par \"Show problems\" link aata hai. Wahan record number, item/party ka naam "
        "aur exact message dikhta hai. \"Download the problem rows\" se poori list CSV mein mil jaati hai — "
        "customer ko bhej kar theek karwa sakte hain."),
    (3, "\"Import N records\" — asli import yahin se shuru hota hai. Uske bagal mein \"Change the "
        "selection\" hai (Step 3 par wapas). Duplicates skip honge, problem rows nahi jaayenge, aur "
        "sab kuch Import History mein likha jaayega."),
])

image(doc, "v05-done.png", "Figure 6 — Import khatam hone ke baad ka result aur Import Center ka History tab")

figure_points(doc, [
    (1, "\"Import finished\" — kitne records gaye, kitne skip hue, kitne nahi gaye. Neeche saaf likha hota "
        "hai ki Vyapar ke vouchers, party balances aur cash/bank opening is version mein import nahi hote."),
    (2, "Import Center → History tab — har batch ka apna entry: date, data type aur details (kis file se, "
        "kitne imported / skipped / failed). Kuch din baad \"kisne kab import kiya\" isi se pata chalta hai."),
])

note_box(doc, "\"Nothing could be posted — see the problems\" dikhe to", "Matlab opening stock ka ek bhi "
         "row post nahi hua. Aksar wajah: warehouse select nahi kiya, ya go-live date set nahi hai, ya "
         "items pehle import nahi hue. Step 3 par jaakar warehouse/go-live check karein, items ka result "
         "dekhein, phir dobara preview karein.", tone="danger")

# ------------------------------------------------------------------ 6 · after import
h1(doc, "6 · Import ke baad 6 checks (5 minute)")
para(doc, "Import \"finished\" dikhna kaafi nahi — 6 cheezein check karein. Sab sahi ho to customer ko "
          "handover kar dein.")
table(doc, ["#", "Kya check karein", "Kahan", "Sahi kya hai"], [
    ["1", "Import History", "Utilities → Import Center → History", "Har data type ka entry, imported + failed count"],
    ["2", "Customers ki ginti", "Masters → Customers", "Vyapar wale count se match (187)"],
    ["3", "Suppliers ki ginti", "Masters → Suppliers", "18"],
    ["4", "Items ki ginti aur GST", "Masters → Items", "2,512 items; GST % khaali nahi hona chahiye"],
    ["5", "Stock value", "Inventory → Stock Balance (go-live date par)", "₹3,95,81,845.82 ke aas-paas"],
    ["6", "Ek sample item aur party", "Masters → Items → koi item kholein", "Rate, unit, HSN sahi; party ka "
     "phone/address sahi"],
], widths=[0.9, 4.2, 5.4, 6.0])

note_box(doc, "Kuch records kam lag rahe hain to", "Pehle History kholiye — wahan \"skipped\" aur "
         "\"failed\" ki ginti likhi hoti hai. Skipped = pehle se maujood (theek hai). Failed = problem "
         "rows; unki list download karke theek karein aur sirf wahi file dobara import karein.", tone="tip")

# ------------------------------------------------------------------ 7 · sample result
h1(doc, "7 · Is customer (SAI NIRMAN INDUSTRIES) ka expected result")
para(doc, "Aapke diye gaye backup 02-11-2026_16.27.10_SAI_NIRMAN_INDUSTRIES_VypBackup.vyb se ye numbers "
          "aane chahiye. Import ke baad inhi se milaayein.")
table(doc, ["Cheez", "Vyapar backup mein", "ManuFlow mein import ke baad"], [
    ["Customers", "187", "187 parties (customer type)"],
    ["Suppliers", "18", "18 parties (supplier type)"],
    ["Receivable (customer balance)", "₹4,15,006.83", "Abhi import nahi hota — go-live par set hoga"],
    ["Items", "2,512 (204 service, 2 code wale)", "2,512 items"],
    ["Items with stock", "2,084", "2,084 opening stock rows"],
    ["Stock quantity", "1,22,768.45 units", "1,22,768.45 units"],
    ["Stock value", "₹3,95,81,845.82", "₹3,95,81,845.82 (rate = value ÷ qty)"],
    ["Items without GST rate", "230", "Default rate lagega (Step 3 mein chuna hua)"],
    ["Items without HSN", "358", "Import ho jaate hain, par GST invoice se pehle HSN bharein"],
    ["Vouchers (sale/purchase/payment)", "1,319 (1 Apr 2026 – 31 Oct 2026)", "Import nahi hote — sirf summary"],
    ["Company", "GSTIN 27BEKPG6599D1Z4, Maharashtra", "Firm ka GSTIN/state milaayein"],
], widths=[4.4, 5.6, 6.5])
para(doc, "Itna hi farq dikhe to import sahi hai: customers/suppliers/items ke count aur stock value. "
          "Baaki cheezein (bills, payments, party balance) is version mein jaan-boojh kar nahi aate.",
     size=10, color=MUTED)

# ------------------------------------------------------------------ 8 · Excel/CSV
h1(doc, "8 · Doosra rasta — Excel / CSV (backup na mile to)")
para(doc, "Agar customer .vyb nahi de sakta, to Vyapar se party list / item list / stock report Excel mein "
          "export karwayein aur Import Center → Excel / CSV se laayein. Ek file mein ek hi type ka data rakhein.")
table(doc, ["Limit", "Value", "Kya karein agar zyada ho"], [
    ["File size", "2 MB", "File ko 2–3 hisson mein baantein"],
    ["Rows per file", "500", "Data type ke hisaab se alag-alag file banayein"],
    ["Format", ".xlsx, .csv, .tsv", ".xls purani file support nahi — \"Save as .xlsx\" karein"],
    ["XML", "Nahi padha jaata", "Excel/CSV mein export karein ya Tally connector use karein"],
], widths=[3.4, 5.4, 7.5])
steps(doc, [
    "Import Center → Excel / CSV card → file chunein.",
    "Data type chunein (Parties / Items / Opening stock).",
    "ManuFlow aapke columns ko ManuFlow ke fields se match karta hai — \"Column mapping\" screen par "
    "check karein: Name, Phone, GSTIN, Balance / Item name, Code, UOM, GST rate, HSN, prices.",
    "Preview dekhein, phir Import dabayein.",
])
note_box(doc, "Vyapar ki report mein column ke naam alag hote hain", "ManuFlow inhe khud pehchaan leta hai "
         "(\"Party Name\" → Name, \"GSTIN/UIN\" → GSTIN, \"Item Name\" → Name, \"Sale Price\" → selling price). "
         "Jo pehchaan na ho, use mapping screen par haath se chunein. Field khaali chhodna ho to \"Skip\" "
         "rakhein.", tone="info")

# ------------------------------------------------------------------ 9 · Tally
h1(doc, "9 · Tally wale customer ke liye")
para(doc, "Tally ka data do tareeke se aata hai — Import Center ka Tally card (connector) sabse aasan hai. "
          "Connector customer ke computer par Tally se baat karta hai aur masters + vouchers laata hai. "
          "Sirf XML file upload karna is version mein support nahi hai: aisi file chunein to message aata hai "
          "\"Tally / Vyapar XML exports are not read as a file yet…\" — us case mein report Excel/CSV mein "
          "export karein.")

# ------------------------------------------------------------------ 10 · messages
h1(doc, "10 · Message aaye to kya karein")
para(doc, "Ye messages aapko screen par mil sakte hain — exact text English mein hai, matlab Hinglish mein.")
table(doc, ["Message (jaisa dikhta hai)", "Matlab", "Solution"], [
    ["The backup could not be read", "File corrupt hai, ya Vyapar ka backup nahi hai", "Vyapar se naya "
     "backup lein; .vyb ya .vyp hi chunein"],
    ["This is a Vyapar backup — import it from Import Center → Vyapar…", "Aapne .vyb file Excel wizard "
     "mein daali", "Vyapar card se import karein"],
    ["Choose a warehouse", "Opening stock tick hai par warehouse nahi chuna", "Step 3 mein warehouse chunein"],
    ["Confirm the go-live date 2026-04-01 for this import", "Go-live date pehle set nahi thi", "Go-live "
     "panel mein date save karein, phir import"],
    ["The go-live date … is in the future", "Aap future date par opening stock daal rahe hain", "Date aaj "
     "ya usse pehle rakhein"],
    ["Unit \"PACKS\" is not one of NOS, PCS, KG…", "Item ki unit ManuFlow ki list mein nahi", "Step 3 mein "
     "\"Unit for units ManuFlow does not have\" chunein"],
    ["GST rate is blank — enter the rate", "Item par GST rate nahi", "Step 3 mein default rate chunein ya "
     "item master mein bharein"],
    ["Phone must be a 10-digit number (98230695594)", "Party ka phone galat hai", "Ab automatic clean ho "
     "jaata hai; fir bhi aaye to party Ka phone theek karein"],
    ["Nothing could be posted — see the problems", "Opening stock ka koi row post nahi hua", "Warehouse / "
     "go-live / items check karein, dobara preview"],
    ["The file is larger than 2 MB", "Excel/CSV bahut badi hai", "File baantein (500 rows per file)"],
    ["The import stopped", "Server side error ya permission issue", "Message padhein; permission ho to "
     "dobara try karein, warna admin ko bhejein"],
], widths=[5.3, 5.0, 6.2])

# ------------------------------------------------------------------ 11 · checklist
h1(doc, "11 · Checklist (print karke paas rakhein)")
h2(doc, "Import se pehle")
bullets(doc, [
    "Customer ka Vyapar backup liya hua hai (.vyb ya .vyp) aur file khulti hai.",
    "Backup usi firm ka hai jiska data aana hai (naam + GSTIN milaya).",
    "ManuFlow mein firm ka naam, GSTIN aur state sahi bhara hua hai.",
    "Kam se kam ek warehouse bana hua hai.",
    "Go-live date decide ho gayi hai (aaj ya pehle ki koi date).",
    "Aapke user ke paas Import Center + jis module ka data hai uski write permission hai.",
])
h2(doc, "Import ke baad")
bullets(doc, [
    "History mein sab batches dikh rahe hain, koi \"failed\" bada number nahi.",
    "Customers, suppliers, items ke count Vyapar se match kar rahe hain.",
    "Stock report ki value Vyapar ke closing stock se match kar rahi hai.",
    "GST % khaali items ki list bana kar customer ko de di gayi hai (invoice se pehle bharne ke liye).",
    "Customer ko likh kar de diya hai ki purane bills/payments abhi import nahi hote.",
    "Backup file aur import ki History ka screenshot archive mein rakha hua hai.",
])

h2(doc, "Dobara import karna ho to?")
para(doc, "Wahi backup dobara import karne par ManuFlow duplicate naam/code pehchaan kar skip kar deta hai — "
          "isliye galti se double data nahi banta. Naye items/parties hi add honge. Opening stock dobara "
          "post karne se pehle admin se poochhein, kyunki go-live date lock ho jaati hai.")

# ------------------------------------------------------------------ 12 · glossary
h1(doc, "12 · Shabd-kosh (glossary)")
table(doc, ["Shabd", "Matlab"], [
    [".vyb", "Vyapar ki backup file — andar ek ZIP hota hai jismein .vyp database hoti hai"],
    [".vyp", "Vyapar ka database file (SQLite). ManuFlow ise seedha bhi padh leta hai"],
    ["Import Center", "ManuFlow ka wo page jahan se purana data aata hai (Utilities → Import Center)"],
    ["Preview / Check the data", "Bina save kiye data check karna — sirf report milti hai"],
    ["Batch", "Ek baar mein jaane wale records ka group (500 records)"],
    ["Go-live date", "Aapki books ka pehla din ManuFlow mein; opening stock ek din pehle post hota hai"],
    ["Opening stock", "Purana stock jo naye software mein shuruaat mein daala jaata hai"],
    ["GSTIN / HSN / UOM", "GST number / product code (HSN-SAC) / unit of measure (KG, NOS…)"],
    ["Duplicate", "Jo record pehle se ManuFlow mein hai — import mein skip ho jaata hai"],
    ["Problem row", "Wo record jo validation fail hone ki wajah se import nahi hua"],
], widths=[4.2, 12.3])

para(doc, "", space_after=6)
note_box(doc, "Madad chahiye?", "Pehle is guide ka Chapter 10 (messages) dekhein. Phir bhi baat na bane to "
         "import ke waqt ka screenshot aur backup file ka naam le kar apni support team ko bhejein — History "
         "tab ke details se exact batch pata chal jaata hai.", tone="info")

doc.save(OUT)
print("saved", OUT, os.path.getsize(OUT) // 1024, "KB")
