"""Builds docs/ManuFlow-User-Guide-Hinglish.docx — a beginner user manual with screen visuals."""
import os
from docx import Document
from docx.shared import Pt, Cm, Inches, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.section import WD_SECTION
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

HERE = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(HERE, "shots")
OUT = os.path.join(os.path.dirname(HERE), "ManuFlow-User-Guide-Hinglish.docx")

EMERALD = RGBColor(0x04, 0x78, 0x57)
EMERALD_DARK = RGBColor(0x06, 0x5F, 0x46)
INK = RGBColor(0x0F, 0x17, 0x2A)
MUTED = RGBColor(0x64, 0x74, 0x8B)
AMBER = RGBColor(0xA1, 0x62, 0x07)
RED = RGBColor(0xB9, 0x1C, 0x1C)
BLUE = RGBColor(0x1D, 0x4E, 0xD8)

BODY_FONT = "Calibri"


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
    tbl = table._tbl
    tblPr = tbl.tblPr
    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        el = OxmlElement(f"w:{edge}")
        el.set(qn("w:val"), "none")
        el.set(qn("w:sz"), "0")
        borders.append(el)
    tblPr.append(borders)


def table_borders(table, color="DFE6E4", size=6):
    tbl = table._tbl
    tblPr = tbl.tblPr
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
    hdr.text = "ManuFlow ERP  ·  User Guide (Hinglish)"
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
    p = doc.add_paragraph(text, style="Heading 1")
    return p


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
    """parts: list of (text, bold) tuples."""
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


def image(doc, filename, caption, width=6.2):
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


def numbered_figure_points(doc, items):
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
cp.title = "ManuFlow ERP — User Guide (Hinglish)"
cp.subject = "Beginner user manual for the ManuFlow manufacturing ERP"
cp.author = "ManuFlow documentation"
cp.keywords = "ERP, Hinglish, user guide, manufacturing, GST"
cp.comments = "Screen visuals are annotated UI diagrams built from the real labels in the app."
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
r.font.size = Pt(38)
r.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
p2 = cell.add_paragraph()
p2.paragraph_format.space_after = Pt(20)
r2 = p2.add_run("Manufacturing SaaS Suite  ·  Complete User Guide")
r2.font.size = Pt(14)
r2.font.color.rgb = RGBColor(0xD1, 0xFA, 0xE5)
p3 = cell.add_paragraph()
r3 = p3.add_run("Hinglish me — bilkul shuru se")
r3.bold = True
r3.font.size = Pt(17)
r3.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)

para(doc, "", space_after=10)
para(doc, "Ye guide kiske liye hai", size=12, bold=True, color=EMERALD)
para(doc, "Jo pehli baar ERP software use kar raha hai — dukaan/store ka staff, accounts team, "
          "production supervisor, sales executive, ya naya admin. Kisi bhi computer knowledge ke "
          "bina padha ja sakta hai. Har screen ke saath image hai aur usme numbers diye hain, "
          "taaki aap dekh kar samajh sakein ki kaunsa button dabana hai.", space_after=10)

meta = doc.add_table(rows=4, cols=2)
no_borders(meta)
for i, (k, v) in enumerate([
    ("Version", "1.0  (31 October 2026)"),
    ("App", "ManuFlow ERP — Next.js 16, MySQL, GST-ready"),
    ("Kisne banaya", "Development team ke saath automated documentation pass"),
    ("Bhasha", "Hinglish (Hindi + English technical shabd)"),
]):
    c0, c1 = meta.rows[i].cells
    r = c0.paragraphs[0].add_run(k)
    r.bold = True
    r.font.size = Pt(9.5)
    r.font.color.rgb = MUTED
    r2 = c1.paragraphs[0].add_run(v)
    r2.font.size = Pt(9.5)

para(doc, "", space_after=20)
note_box(doc, "Images ke baare me ek saaf baat",
         "Is guide ki images app ke asli layout, labels aur brand colours se banayi gayi screen "
         "diagrams hain — button ke naam, column ke naam aur values bilkul wahi hain jo software me "
         "dikhte hain. (Documentation build machine par headless browser available nahi tha, isliye "
         "live photo capture nahi hua.) Aapke computer par app kholne par layout inhi images jaisa "
         "milega.", tone="info")

# ------------------------------------------------------------------ contents + quick start
h1(doc, "Is guide me kya-kya hai", page_break=True)
contents = [
    ("1.", "ERP kya hai aur ManuFlow kis kaam aata hai"),
    ("2.", "Pehli baar login — 4 fields ka kaam"),
    ("3.", "App ka naksha: sidebar, header, Ctrl+K"),
    ("4.", "Master data: Items, Parties, Warehouse, BOM, Users"),
    ("5.", "Sales cycle: enquiry se invoice tak"),
    ("6.", "Purchase cycle: requisition se bill tak"),
    ("7.", "Stock samajhna: on hand, reserved, available"),
    ("8.", "Production: work order, job card, production entry, QC"),
    ("9.", "Billing aur GST: invoice, print, e-invoice, Tally"),
    ("10.", "Paisa aur reports: receivables, payables, GST reports"),
    ("11.", "Admin kaam: settings, users, audit log, backup"),
    ("12.", "Mobile par ManuFlow: install, offline, cards"),
    ("13.", "Roz / hafte / mahine ka routine checklist"),
    ("14.", "Common galtiyan aur unka solution"),
    ("15.", "Shabd-kosh (glossary) aur keyboard shortcuts"),
]
for num, title in contents:
    p = doc.add_paragraph()
    p.paragraph_format.left_indent = Cm(0.8)
    p.paragraph_format.first_line_indent = Cm(-0.8)
    p.paragraph_format.space_after = Pt(2)
    r = p.add_run(f"{num}  ")
    r.bold = True
    r.font.color.rgb = EMERALD
    p.add_run(title)

h2(doc, "10 minute ka quick start (sirf 3 kaam)")
para(doc, "Agar aapko theory nahi padhni aur bas software chalana hai, to sirf ye teen kaam karein. "
          "Baaki sab baad me samajh aayega.", space_after=6)
steps(doc, [
    ("Login karein. ", "Email + password + company chunein → Sign in. (Chapter 2)"),
    ("Do master banayein. ", "Masters → Items me apna pehla item, Masters → Parties me ek customer. "
                              "Master ke bina koi bill nahi banega. (Chapter 4)"),
    ("Pehla invoice banayein. ", "Sales → Sales Invoices → + naya invoice → customer, item, qty → Save → "
                                 "Print/PDF. Bas, aapne pehla GST bill bana liya. (Chapter 9)"),
])
note_box(doc, "Sabse zaroori baat",
         "Har naya record pehle master me banao (item, party, warehouse), phir document banao "
         "(order, GRN, invoice). Ulta karne par dropdown khali milega aur aapko lagega ki software "
         "kharab hai — dar-asal master hi missing hai.", tone="warn")

# ------------------------------------------------------------------ chapter 1
h1(doc, "1.  ERP kya hai aur ManuFlow kis kaam aata hai")
para(doc, "ERP ka matlab hai: ek hi software jisme poori factory ka hisaab rehta hai — kya bana, "
          "kitna bika, kitna stock hai, kis customer se paisa lena hai, aur sarkar ko kitna GST "
          "dena hai. Pehle log ye sab alag-alag register aur Excel me rakhte the, isliye ek jagah "
          "ki galti doosri jagah pata nahi chalti thi.")
para(doc, "ManuFlow ek manufacturing ERP hai jo khaas Indian factories ke liye bana hai. Iska "
          "sabse bada faayda: jab aap ek bill save karte hain, to stock, ledger, customer ka "
          "outstanding aur GST report — sab apne aap update ho jaate hain. Aapko dobara entry "
          "nahi karni padti.")
image(doc, "01-flow.png", "Chitra 1.1 — Ek order ka poora safar: enquiry se paisa aane tak. Isi order me kaam karein.")

h2(doc, "ManuFlow ke 5 hisse")
table(doc,
      ["Hissa", "Isme kya hota hai", "Kaun use karta hai"],
      [["Masters", "Item, party (customer/supplier), warehouse, machine, BOM, users", "Admin / store"],
       ["Sales", "Enquiry, quotation, sales order, delivery, invoice, return, payment in", "Sales team"],
       ["Purchase", "Requisition, purchase order, GRN, purchase bill, return", "Purchase team / store"],
       ["Manufacturing", "Work order, material issue, production entry, MRP, QC", "Production / QC"],
       ["Inventory + Finance", "Stock, transfer, adjustment, receivables, payables, cash & bank, GST", "Store + accounts"]],
      widths=[3.2, 8.8, 3.4])

h2(doc, "Kis role ko kya dikhta hai")
para(doc, "Har user ka role hota hai. Role ke hisaab se sidebar me sirf wahi module dikhte hain jinka "
          "haq hai. Agar aapko koi module nahi dikh raha, iska matlab aapke role me wo permission "
          "nahi hai — admin se baat karein.")
table(doc,
      ["Role", "Aam taur par kya karta hai"],
      [["Tenant Admin", "Sab kuch — settings, users, company, backup, reports"],
       ["Management", "Dashboard, reports, approvals (bina editing ke bhi)"],
       ["Plant / Production Manager", "Work orders, production entries, MRP, QC"],
       ["Store Manager / Operator", "GRN, stock, transfer, adjustment, material issue"],
       ["Purchase Manager / Executive", "Requisition, PO, purchase bill, supplier ledger"],
       ["Sales Manager / Executive", "Enquiry, quotation, sales order, invoice, payment in"],
       ["Accounts Manager / Accountant", "Receivables, payables, cash & bank, expenses, GST reports"],
       ["Quality Manager / QC Inspector", "QC inspections aur certificates"],
       ["Viewer", "Sirf dekh sakta hai, change nahi kar sakta"]],
      widths=[6.0, 9.4])

# ------------------------------------------------------------------ chapter 2
h1(doc, "2.  Pehli baar login — 4 fields ka kaam")
image(doc, "02-login.png", "Chitra 2.1 — Login screen. Numbers guide ke steps se match karte hain.")
numbered_figure_points(doc, [
    (1, "Email — jo email company admin ne diya hai (jaise owner@company.com)."),
    (2, "Password — pehli baar admin se jo mila. Login ke baad change kar lein."),
    (3, "Company — agar aapke paas ek se zyada firm hai to yahan chunein. Ek login me ek waqt par ek company ka data khulta hai."),
    (4, "Sign in — dabane par seedha Dashboard khulega."),
])
h2(doc, "Login ke baad turant ye 3 kaam karein")
steps(doc, [
    ("Password badlein — ", "top-right avatar → Change password. Purana password kisi ke saath share na karein."),
    ("Company profile check karein — ", "Admin → Settings me naam, address, GSTIN aur invoice numbering sahi honi chahiye."),
    ("Apne users banao — ", "Masters → Users & Roles. Har user ko uske kaam ka role dein (sales ko Accounts mat dein)."),
])
note_box(doc, "Password bhool gaye?", "Software khud password nahi bhejta. Company ka admin (Tenant Admin) "
         "aapka password reset karega. Bina admin ke koi doosra raasta nahi hai — ye security ke liye "
         "jaan-boojh kar aisa rakha gaya hai.", tone="info")

# ------------------------------------------------------------------ chapter 3
h1(doc, "3.  App ka naksha: sidebar, header, Ctrl+K")
image(doc, "03-dashboard.png", "Chitra 3.1 — Dashboard. Numbers niche diye gaye hain.")
numbered_figure_points(doc, [
    (1, "Sidebar — poore software ka menu. Group par click karke list khulti hai (Masters, Sales, Purchase…)."),
    (2, "Global search — yahan click karein ya Ctrl + K dabayein: kisi bhi module par seedha jump."),
    (3, "KPI cards — mahine ki sale, kharid, open orders, low stock. Card par click karne se usi module par chale jaate hain."),
    (4, "Quick actions — Sales Order, Quotation, Purchase Order, Payment In, Work Order, GST Report. Ek click me naya document."),
    (5, "Notifications (ghanti) — naya order, approval, low stock ki suchna."),
])
para(doc, "Header me module ka naam, search, notification aur aapka account menu hota hai. Account menu me "
          "theme (light/dark), password change, keyboard shortcuts aur mobile par company switch bhi milta hai.")

h2(doc, "Ctrl + K — sabse tez tareeka")
image(doc, "04-palette.png", "Chitra 3.2 — Command palette: 1 search box, 2 module list, 3 records (customer, item, order).")
numbered_figure_points(doc, [
    (1, "Yahan 2-3 akshar likhein — jaise “stock” ya “GST”."),
    (2, "Upar modules aate hain. ↑ ↓ se chunein, Enter dabayein."),
    (3, "Neeche aapke records bhi aate hain — customer ka naam likh kar seedha uska order khol sakte hain."),
])
note_box(doc, "Mobile par bhi wahi app", "Phone par sidebar ek drawer ban jaata hai — upar left ke ☰ button se "
         "khulta hai, item chunne par khud band ho jaata hai. Detail chapter 12 me hai.", tone="tip")

# ------------------------------------------------------------------ chapter 4
h1(doc, "4.  Master data: pehle ye banao")
para(doc, "Master data wo list hai jise baar-baar use kiya jaata hai. Ek baar sahi bana lein to "
          "har bill me dropdown se chun sakte hain. Ghalat master baad me har jagah ghalat number "
          "deta hai, isliye isme thoda waqt lagayein.")

h2(doc, "4.1  Items (material aur finished goods)")
image(doc, "05-items.png", "Chitra 4.1 — Items list: 1 naya item, 2 search, 3 export/filters, 4 columns, 5 low stock row.")
numbered_figure_points(doc, [
    (1, "＋ Item — naya item banane ka button (sabse right)."),
    (2, "Search items… — code ya naam se turant dhoondein."),
    (3, "Export CSV / Export Excel — poori list file me nikaalein. Views se apni pasand ki column setting save kar sakte hain."),
    (4, "In Stock / Reorder column — stock kitna hai aur reorder level kya hai."),
    (5, "Peeli row ka matlab: stock reorder level se neeche hai (Low Stock)."),
])
image(doc, "06-item-form.png", "Chitra 4.2 — Naya item form: 3 tabs. 1 naam/code, 2 type, 3 HSN + unit, 4 Pricing/Stock tab, 5 Create.")
numbered_figure_points(doc, [
    (1, "Name aur Code — code short rakhein (RM-SHF, FG-BRK); search aur reports me kaam aata hai. Code khali chhode to software auto bana deta hai."),
    (2, "Type aur Category — Type: Raw Material, Semi-Finished, Finished Good, Consumable, Service. Category free text hai (jaise Fasteners)."),
    (3, "HSN/SAC Code, UOM aur Status — HSN 4-6 digit, UOM KG/NOS/LTR/MTR. Neeche secondary unit (jaise 1 BOX = 24 KG) bhi set ho sakti hai."),
    (4, "Pricing tab par Purchase Price, Selling Price, MRP aur GST Rate %; Stock tab par Standard Cost aur Min Stock. Save se pehle dono tabs ek baar dekh lein."),
    (5, "Create — item save. Edit karte waqt button “Update” ho jaata hai."),
])
note_box(doc, "Item ka status", "Agar item inactive ho gaya hai to naye bill me nahi dikhega, purane bill "
         "waise hi rahenge. Delete ki jagah inactive karein — history safe rehti hai.", tone="tip")

h2(doc, "4.2  Parties (customer aur supplier)")
steps(doc, [
    "Masters → Parties kholein. Customers aur Suppliers do tabs me hote hain.",
    "＋ Customer / ＋ Supplier dabayein.",
    ("Naam, GSTIN, state aur address bharein. ", "State se hi tay hota hai ki bill me CGST+SGST lagega ya IGST."),
    "Save karein. Credit limit aur Tally ledger name optional hain, par accounts team ko faayda hota hai.",
])
note_box(doc, "GSTIN kaise check karein", "GSTIN 15 akshar ka hota hai: pehle 2 = state code (Maharashtra = 27), "
         "phir 10 = PAN, phir entity code + Z + checksum. Ek akshar galat hua to return file nahi hoti.", tone="warn")

h2(doc, "4.3  Baaki masters")
table(doc,
      ["Master", "Kis kaam aata hai", "Zaroori fields"],
      [["Warehouses", "Godown / store / shop floor — stock isi ke hisaab se rehta hai", "Naam, code, location"],
       ["Machines", "Machine-wise production aur downtime", "Naam, code, capacity"],
       ["BOM (Bill of Materials)", "1 finished item banane me kya-kya lagta hai", "Output item, qty, line items"],
       ["Users & Roles", "Kaun login karega aur kya kar sakta hai", "Naam, email, role, active"],
       ["Company Setup (Admin menu)", "Nayi firm / naya tenant", "Firm naam, GSTIN, state, FY"]],
      widths=[3.6, 7.4, 4.6])

# ------------------------------------------------------------------ chapter 5
h1(doc, "5.  Sales cycle: enquiry se invoice tak")
para(doc, "Sales me har step ek document hai. Aap har step skip kar sakte hain — jaise seedha "
          "invoice bhi bana sakte hain — par step follow karne se pata rehta hai ki order kahan atka hai.")
table(doc,
      ["Step", "Screen", "Kya hota hai"],
      [["1", "Enquiries", "Customer kya chahata hai — qty, item, delivery date"],
       ["2", "Quotations", "Rate aur terms customer ko bhejna (print/PDF)"],
       ["3", "Sales Orders", "Order pakka — production aur billing ka base"],
       ["4", "Delivery Challans", "Maal bhejna (stock minus), bill baad me"],
       ["5", "Sales Invoices", "GST bill — stock minus, ledger entry, e-invoice"],
       ["6", "Payment In", "Customer se paisa aaya — outstanding kam"]],
      widths=[1.6, 4.0, 9.8])
image(doc, "07-sales-orders.png", "Chitra 5.1 — Sales Orders list: 1 naya order, 2 columns, 3 status.")
numbered_figure_points(doc, [
    (1, "＋ Sales Order — naya order. Customer, delivery date aur item lines bharein."),
    (2, "SO #, date, customer, grand total, delivery — jo nazar aa raha hai wahi report me jaata hai."),
    (3, "Status: DRAFT (adhoora) → CONFIRMED (pakka) → RELEASED (production ko bheja) → COMPLETED. "
        "OVERDUE ka matlab delivery date nikal gayi."),
])
h2(doc, "Invoice banate waqt 4 cheezein")
steps(doc, [
    ("Customer aur place of supply ", "— same state (27 → 27) me CGST + SGST, doosre state me IGST."),
    ("Item line ", "— item chunein, qty daalein. HSN aur GST rate master se apne aap aayega."),
    ("Totals check ", "— taxable value, tax, round off, grand total."),
    ("Create Invoice → print ", "— save ke baad list me invoice ke row par printer icon se A4/A5 print ya PDF nikaalein. Stock aur ledger automatic update."),
])

# ------------------------------------------------------------------ chapter 6
h1(doc, "6.  Purchase cycle: requisition se bill tak")
para(doc, "Purchase me paisa bahar jaata hai, isliye yahan ek extra step hai — GRN. Jab maal godown "
          "me aata hai tab GRN banate hain, aur GRN “Post to Stock” karne par hi stock badhta hai.")
table(doc,
      ["Step", "Screen", "Kya hota hai"],
      [["1", "Requisitions", "Andar se maang — kya chahiye, kitna"],
       ["2", "Purchase Orders", "Supplier ko order — rate aur delivery date"],
       ["3", "GRN", "Maal aaya — Post to Stock karne par stock badhta hai"],
       ["4", "Purchase Invoices", "Supplier ka bill — payable aur input GST"],
       ["5", "Purchase Returns", "Maal wapas — debit note, stock minus"]],
      widths=[1.6, 4.0, 9.8])
image(doc, "08-grn.png", "Chitra 6.1 — GRN list: 1 naya GRN, 2 Post to Stock, 3 status column.")
numbered_figure_points(doc, [
    (1, "＋ GRN — supplier, PO number aur supplier invoice number daalein."),
    (2, "Post to Stock — yahi button stock badhata hai. Draft GRN ka stock nahi badhta."),
    (3, "POSTED ka matlab stock me jud gaya; DRAFT ka matlab abhi sirf entry hai."),
])
note_box(doc, "Sabse common galti", "GRN bana kar “Post to Stock” bhool jaana. Phir production me material "
         "nahi milta aur stock report galat dikhti hai. Roz shaam ko GRN list me DRAFT rows check karein.", tone="danger")

# ------------------------------------------------------------------ chapter 7
h1(doc, "7.  Stock samajhna: qty, average rate aur value")
image(doc, "09-stock.png", "Chitra 7.1 — Stock Balances: 1 tabs, 2 warehouse filter, 3 Qty/Avg Rate/Value, 4 Reorder.")
numbered_figure_points(doc, [
    (1, "Tabs — Balances (item-wise stock), Batches & Expiry (batch aur expiry wale item), Serial numbers (machine/serial-wise)."),
    (2, "Warehouse filter — ek godown ka stock dekhna ho to yahan chunein."),
    (3, "Qty = godown me kitna hai. Avg Rate = moving-average cost (har GRN par average update hota hai). Value = Qty × Avg Rate."),
    (4, "Reorder = reorder level. Qty isse neeche jaate hi row peeli (Low Stock) dikhne lagti hai."),
])
h2(doc, "Stock kab apne aap badalta hai")
table(doc,
      ["Kaam", "Stock par asar"],
      [["GRN “Post to Stock”", "Raw material stock badhta hai (plus)"],
       ["Material Issue", "Raw material stock kam hota hai (minus)"],
       ["Production Entry", "FG stock badhta hai, RM already issue se kam hua"],
       ["Delivery Challan / Sales Invoice", "FG stock kam hota hai"],
       ["Sales Return", "Stock wapas badhta hai; Purchase Return me kam"],
       ["Transfers & Adjustments", "Ek godown se doosre me transfer, ya physical count ke baad correction"]],
      widths=[6.4, 9.0])
para(doc, "Transfer aur Adjustment alag module hai: Inventory → Transfers & Adjustments. Stock screen sirf "
          "dikhata hai, badalta nahi — isliye galti se qty change hone ka dar nahi rehta.", italic=True)
note_box(doc, "Value kaise nikalti hai", "Moving average ka matlab: 10 KG ₹70 me aur 10 KG ₹80 me aaya, "
         "to average ₹75 hoga. Bill me cost isi average se jaati hai — isliye GRN galat rate par post karne se "
         "aage ke saare profit numbers galat ho jaate hain.", tone="info")

# ------------------------------------------------------------------ chapter 8
h1(doc, "8.  Production: work order, job card, production entry, QC")
image(doc, "10-work-orders.png", "Chitra 8.1 — Work Orders: 1 naya WO, 2 stat cards, 3 status. Niche production ka safar.")
numbered_figure_points(doc, [
    (1, "＋ Work Order — kya banana hai, kitna (planned qty), kab tak (due date) aur priority."),
    (2, "Stat cards — kitne order chal rahe hain, kitne ban gaye, kul planned qty. Subah ka status ek nazar me."),
    (3, "Status: DRAFT → RELEASED (production ko bheja) → IN PROGRESS → COMPLETED. Row par click karne se "
        "poora detail khulta hai — BOM explosion, issued material aur production history."),
])
h2(doc, "Production ka sahi order")
steps(doc, [
    ("Work Order banayein ", "— BOM se material requirement dikhega."),
    ("Material Issue karein ", "— jitna material lagega, stock se store ko nikaalna hai."),
    ("Job card / operation ke hisaab se kaam ", "— cutting, machining, assembly."),
    ("Production Entry daalein ", "— produced qty + rejected qty. Poora hone par Work Order Complete karein."),
    ("QC Inspection ", "— pass hone par certificate; fail hone par rework/scrap."),
    ("MRP ", "— aage ke orders ke liye kya kharidna hai, ye suggest karta hai."),
])
note_box(doc, "Double entry se bachein", "Ek hi production do baar daalne se FG stock double ho jata hai. "
         "Entry karne se pehle Work Order ka “Prod” column dekhein ki itni qty already nahi hai.", tone="warn")

# ------------------------------------------------------------------ chapter 9
h1(doc, "9.  Billing aur GST: invoice, print, e-invoice, Tally")
image(doc, "11-invoice.png", "Chitra 9.1 — Invoice banane ka form: 1 document type, 2 customer/date, 3 item lines, 4 totals, 5 Create Invoice.")
numbered_figure_points(doc, [
    (1, "Document type — Tax Invoice (normal), Bill of Supply (exempt item) ya Proforma (sample/approval); Currency bhi yahin chunte hain. “Cash Sale (walk-in)” tick karne par customer ki zaroorat nahi padti."),
    (2, "Customer, Date, Due Date — GSTIN aur place of supply customer master se aate hain; wahi se CGST+SGST ya IGST tay hota hai."),
    (3, "Item lines — item chunein ya barcode scan karein, qty daalein; HSN aur GST rate master se apne aap aate hain. “+ Add item line” se nayi line."),
    (4, "Totals — taxable value, CGST, SGST/IGST (zaroorat par round off) aur Grand Total."),
    (5, "Create Invoice — save. Uske baad list me invoice ke row par printer icon se A4/A5 print ya PDF nikaalein, aur WhatsApp/email share karein."),
])
h2(doc, "Tax ka simple rule")
table(doc,
      ["Sthiti", "Bill me kya lagta hai"],
      [["Customer Maharashtra (27) me, aap bhi 27 me", "CGST 9% + SGST 9% (kul 18%)"],
       ["Customer doosre state me (jaise Karnataka 29)", "IGST 18%"],
       ["Aap composition dealer ho", "Bill par tax nahi, “composition taxable person” likha jaata hai"]],
      widths=[8.0, 7.4])
h2(doc, "Invoice ke baad kya-kya ban jaata hai")
bullets(doc, [
    ("Stock: ", "FG stock minus; batch/serial ho to uska record bhi."),
    ("Ledger: ", "customer ke receivable me bill amount jud jaata hai."),
    ("GST report: ", "GSTR-1 ke outward supplies me invoice apne aap aa jaata hai."),
    ("Numbering: ", "invoice number series settings ke hisaab se badhta hai (INV/26-27/0006 jaisa)."),
])
h2(doc, "9.1  e-Invoice aur Tally")
para(doc, "Agar aapki turnover ke kaaran e-invoicing lagti hai, to bill ban jaane ke baad do cheezein "
          "karni padti hain: portal par invoice register karana (IRN) aur buyer ko JSON/QR. ManuFlow "
          "dono ke liye ready hai.")
table(doc,
      ["Kaam", "Kahan milega", "Kya hota hai"],
      [["e-Invoice JSON", "Invoice row ka e-Invoice action",
        "Invoice ka portal-ready JSON download hota hai; software pehle check karta hai ki koi field "
        "portal reject karega ya nahi, phir upload ke liye portal tab kholta hai"],
       ["IRN generate", "Invoice row ka IRN action", "IRN invoice ke saath save ho jaata hai aur print par chhapta hai"],
       ["Tally XML / Excel", "Invoice row ka Tally export", "Voucher Tally me import karne ke liye file"],
       ["Tally masters", "Settings → Tally export", "Ledger, unit aur party masters — Tally me ek baar import karein"]],
      widths=[3.6, 4.6, 7.2])
note_box(doc, "E-Way bill", "E-Way bill number invoice par note ki tarah save hota hai aur print par aata hai. "
         "Bill generate karna portal ka kaam hai — ManuFlow usko record karta hai.", tone="info")

note_box(doc, "Print se pehle", "Browser ka print preview khol kar ek baar dekh lein ki page cut nahi ho raha. "
         "Paper size A4 default hai; chhote printer ke liye Settings me receipt width chuni ja sakti hai.", tone="tip")

# ------------------------------------------------------------------ chapter 10
h1(doc, "10.  Paisa aur reports: receivables, payables, GST")
image(doc, "12-gst.png", "Chitra 10.1 — GST Reports: 1 period, 2 tiles, 3 export JSON.")
numbered_figure_points(doc, [
    (1, "Period aur company — pehle sahi mahina chunein."),
    (2, "Outward value, CGST, SGST, IGST, input credit, net payable — ek nazar me."),
    (3, "GSTR-1 JSON — portal par upload karne ki file. Export Excel — CA ko bhejne ke liye."),
])
h2(doc, "Finance me kya-kya hai")
table(doc,
      ["Screen", "Kaam"],
      [["Receivables", "Kis customer se kitna paisa lena hai, kitne din purana"],
       ["Payables", "Kis supplier ko kitna dena hai"],
       ["Cash & Bank", "Cash in hand, bank accounts, contra entry, loan"],
       ["Expenses", "Bijli, kiraya, salary — category wise"],
       ["GST Reports", "GSTR-1 / GSTR-3B ke numbers, JSON export"],
       ["Reports Center", "Sales, purchase, stock, profitability analytics"]],
      widths=[4.2, 11.2])

# ------------------------------------------------------------------ chapter 11
h1(doc, "11.  Admin kaam: settings, users, audit log, backup")
h2(doc, "11.1  Settings me kya set hota hai")
table(doc,
      ["Settings ka card", "Kya set hota hai"],
      [["Company Profile", "Naam, address, GSTIN, state, FY — har print par yahi aata hai"],
       ["Document Numbering / Document Prefixes", "Invoice, PO, GRN, work order ka prefix aur next number"],
       ["Billing Preferences", "Round off, terms, print options"],
       ["Bank Details", "Bill par bank account aur UPI line"],
       ["Logo & Signature", "Print par dikhne wala logo aur sign"],
       ["Tally export", "Tally ke liye ledger-wise export"],
       ["Notifications", "Kis event par alert jaaye (low stock, approval, overdue)"],
       ["Data & Backup", "Backup download, restore, masters export"],
       ["Security", "Password aur session rules"]],
      widths=[6.2, 9.2])
h2(doc, "11.2  Audit log — kisne kya badla")
para(doc, "Admin → Audit Log me har important change ka record hota hai: kis user ne, kab, kya kiya. "
          "Kisi number me gadbad ho to yahin se pata chalta hai.")
h2(doc, "11.3  Backup")
para(doc, "Settings → Data & Backup → “Download backup (JSON)” se company ka poora data ek file "
          "me aa jaata hai. Mahine me ek baar backup le kar safe jagah (Google Drive/pen drive) "
          "rakhein. Restore karte waqt software company ka naam type karwa kar confirm karta hai — "
          "aur restore se pehle khud hi ek backup bana leta hai. Phir bhi backup hamesha pehle lein.")
note_box(doc, "Kuch cheezein delete nahi hotin", "Invoice, GRN, production entry jaise documents cancel "
         "hote hain, delete nahi — taaki hisaab ka record bana rahe. Cancel karne par stock aur ledger "
         "reverse ho jaate hain.", tone="info")

h2(doc, "11.4  Import Center — purana data ManuFlow me laana")
para(doc, "Pehle se Excel, Tally ya Vyapar me hisaab chalta tha? Utilities → Import Center se data "
          "seedha upload ho jaata hai — manually ek-ek item type karne ki zaroorat nahi.")
table(doc,
      ["Source", "Kaam kaise karta hai"],
      [["Tally", "“Import from Tally” — connector ya company backup file se masters aur vouchers"],
       ["Vyapar", "“Import from Vyapar” — supported export file"],
       ["Excel / CSV", "“Import from Excel / CSV” — file chunein, column map karein, preview dekhein, phir import"]],
      widths=[4.4, 11.0])
bullets(doc, [
    "Pehle ek chhoti file se test karein (5-10 rows), phir poora data laayein.",
    "History tab me purane imports ka result dikhta hai — kitni rows aayi, kitni fail hui.",
    "Import se pehle backup lein: galti ho to restore karke wapas aa sakte hain (11.3).",
])

h2(doc, "11.5  Notifications")
para(doc, "Header ki ghanti par click karke saari alerts milti hain — naya order, approval, low stock, "
          "overdue payment. “Mark all read” se list clear karein. Kaunsi alert chahiye ye "
          "Settings → Notifications me tay hota hai.")

# ------------------------------------------------------------------ chapter 12
h1(doc, "12.  Mobile par ManuFlow: install, offline, cards")
image(doc, "13-mobile.png", "Chitra 12.1 — Mobile: baayein drawer menu, daayein record cards.")
para(doc, "Mobile par wahi software chalta hai — alag app nahi. Chhoti screen par sidebar drawer ban "
          "jaata hai aur tables card list me badal jaate hain, taaki ungli se aasani se tap ho sake.")
h2(doc, "12.1  Home screen par install kaise karein (Android)")
steps(doc, [
    "Chrome me software ka address kholein (HTTPS wala link).",
    "Upar right ke ⋮ menu me “Install app” ya “Add to Home screen” chunein.",
    "Home screen par icon aa jayega — usi se kholen, browser ka address bar nahi dikhega.",
])
h2(doc, "12.2  iPhone par")
steps(doc, [
    "Safari me link kholein → Share button → “Add to Home Screen”.",
    "Naam confirm karein → Add. Ab icon se khulega.",
])
h2(doc, "12.3  Offline hone par kya hota hai")
table(doc,
      ["Soch", "Asliyat"],
      [["“Offline me entry kar di, baad me save ho jayegi”", "Nahi. Offline me kuch bhi save nahi hota. Entry ka error aayega."],
       ["“Purana stock dikh raha hai, galat hai”", "Screen par last loaded value rehti hai. Internet aane par reload karein."],
       ["“Offline me bill banaya, wo queue me hoga”", "Aisa koi system nahi hai — jaan-boojh kar nahi banaya, taaki stock galat na ho."]],
      widths=[7.0, 8.4])
note_box(doc, "Internet nahi hai to", "App upar ek peela banner dikhata hai: “You're offline. Nothing is saved "
         "until you reconnect.” Jab network wapas aaye, banner apne aap hat jaata hai aur aap Retry kar "
         "sakte hain.", tone="warn")

# ------------------------------------------------------------------ chapter 13
h1(doc, "13.  Routine: roz, hafte aur mahine me kya karein")
h2(doc, "Roz (shaam ko 10 minute)")
bullets(doc, [
    "GRN list kholen — koi DRAFT bacha ho to Post to Stock karein.",
    "Work Orders par Production Entry daalen jo aaj bana.",
    "Dashboard par Low Stock dekhen; jo item khatam ho raha hai use purchase ke liye list karein.",
])
h2(doc, "Hafte me")
bullets(doc, [
    "Sales Orders me OVERDUE check karein aur customer ko delivery date batayein.",
    "Receivables me 30 din se purane bill dekhein aur reminder bhejein.",
    "Stock Adjustment sirf physical count ke baad hi karein (roz nahi).",
])
h2(doc, "Mahine me")
bullets(doc, [
    "Purchase Invoices complete hain? Supplier ka bill aur GRN match karein.",
    "GST Reports kholen — outward value, tax aur net payable check karein.",
    "Data & Backup se backup lein.",
    "Users list dekhen — jo employee chala gaya uska access inactive karein.",
])

# ------------------------------------------------------------------ chapter 14
h1(doc, "14.  Common galtiyan aur unka solution")
table(doc,
      ["Problem", "Iska matlab", "Kya karein"],
      [["Dropdown me item nahi dikh raha", "Item inactive hai ya doosri company me bana hai", "Items me search karein; inactive ho to dobara active karein"],
       ["Login nahi ho raha", "Email/password galat, ya company galat", "Admin se password reset karayein; company select check karein"],
       ["GSTIN invalid bata raha hai", "15 akshar nahi, ya state code galat", "State code + PAN format phir se check karein"],
       ["Stock badha nahi", "GRN draft hai / Post to Stock nahi kiya", "GRN kholein → Post to Stock"],
       ["Invoice print blank aa raha hai", "Popup block ya print preview", "Browser me popup allow karein, phir Print/PDF"],
       ["Phone par install option nahi", "HTTP link, ya dev server", "HTTPS link use karein; install sirf secure link par"],
       ["Offline me entry save nahi hui", "Design hi aisa hai", "Internet aane par dobara entry karein"],
       ["List slow lag rahi hai", "Bahut saare records ek page par", "Search/filter lagayein, page chhota karein"],
       ["Numbering galat chal rahi hai", "Settings me series galat", "Admin → Settings → numbering check karein"]],
      widths=[4.6, 5.4, 5.4])

# ------------------------------------------------------------------ chapter 15
h1(doc, "15.  Shabd-kosh aur shortcuts")
h2(doc, "15.1  Shabd-kosh (glossary)")
glossary = [
    ["ERP", "Ek hi software me poori company ka hisaab"],
    ["Master", "Permanent list — item, party, warehouse, machine"],
    ["SO / Sales Order", "Customer ka pakka order"],
    ["PO / Purchase Order", "Supplier ko diya gaya order"],
    ["GRN", "Goods Receipt Note — maal godown me aaya"],
    ["BOM", "Bill of Materials — 1 item banane ka recipe"],
    ["WO / Work Order", "Factory ko diya gaya production order"],
    ["FG / RM", "Finished Good (banaya hua) / Raw Material (kachcha)"],
    ["WIP", "Work In Progress — adhoora maal"],
    ["HSN / SAC", "Item/service ka GST code"],
    ["GSTIN", "15 akshar ka GST number"],
    ["CGST / SGST / IGST", "Same state me CGST + SGST, doosre state me IGST"],
    ["FY", "Financial Year — April se March"],
    ["Receivable / Payable", "Lena hai / Dena hai"],
    ["UOM", "Unit — KG, NOS, LTR"],
    ["Reorder level", "Is qty se neeche jaane par stock mangana chahiye"],
    ["MRP", "Yahan matlab Material Requirements Planning (software me ye production ka tool hai); retail wala “Maximum Retail Price” nahi"],
    ["Audit log", "Kisne kya badla — record"],
    ["PWA", "Website jo phone me app ki tarah install ho jaati hai"],
]
table(doc, ["Shabd", "Matlab"], glossary, widths=[4.4, 11.0], font_size=9)

h2(doc, "15.2  Keyboard shortcuts (computer par)")
table(doc,
      ["Shortcut", "Kaam"],
      [["Ctrl + K", "Global search / kisi bhi module par jump"],
       ["/", "Search kholein"],
       ["?", "Keyboard shortcut ki poori list"],
       ["n", "Current screen par naya document"],
       ["Alt + S / Alt + P", "Kahin se bhi naya Sales Invoice / Purchase Bill"],
       ["Ctrl + S  (ya Ctrl + Enter)", "Khula hua form save karein"],
       ["Esc", "Dialog ya palette band karna"],
       ["↑ ↓ , Enter", "Palette me option chunna aur kholna"],
       ["[  /  ]", "Pichla / agla module"],
       ["g phir d / i / c / s / o / n", "Dashboard, Items, Customers, Stock, Sales Orders, Sales Invoices"]],
      widths=[5.6, 9.8])

h2(doc, "15.3  Support ke liye ye baat batayein")
bullets(doc, [
    "Kaunsa module aur kaunsi screen (jaise “Sales Invoices”)",
    "Kya kiya, kya expect kiya, kya hua",
    "Screenshot ya invoice number",
    "Aapka role (jaise Store Operator) — permission ka issue ho sakta hai",
])

para(doc, "", space_after=10)
note_box(doc, "Aakhri baat",
         "Software sirf tab kaam aata hai jab data sahi ho. Item aur party master sahi rakhein, "
         "GRN post karna na bhoolein, aur mahine ka GST ek baar zaroor check karein. Baaki hisaab "
         "ManuFlow khud rakhta hai.", tone="tip")

doc.save(OUT)
print("saved", OUT, os.path.getsize(OUT) // 1024, "KB")
