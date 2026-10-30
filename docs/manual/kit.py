"""Pillow UI kit for the ManuFlow user manual.

Draws screens that mirror the real app: same labels, same emerald palette, same layout
(sidebar groups and module names come from src/components/erp/registry.tsx).
"""
from PIL import Image, ImageDraw, ImageFont
import os

FONT_DIR = "/usr/share/fonts/truetype/dejavu"
F = {
    (False, 11): os.path.join(FONT_DIR, "DejaVuSans.ttf"),
    (True, 11): os.path.join(FONT_DIR, "DejaVuSans-Bold.ttf"),
}

# Design tokens (light theme) taken from src/app/globals.css
BG = "#f6f8f8"
CARD = "#ffffff"
BORDER = "#dfe6e4"
TEXT = "#0f172a"
MUTED = "#64748b"
PRIMARY = "#047857"
PRIMARY_DARK = "#065f46"
PRIMARY_SOFT = "#d9f2e8"
ACCENT = "#b45309"
ACCENT_SOFT = "#fdf0dc"
SUCCESS = "#15803d"
SUCCESS_SOFT = "#dcf5e5"
WARN = "#a16207"
WARN_SOFT = "#fdf6dd"
DANGER = "#b91c1c"
DANGER_SOFT = "#fbe4e4"
INFO = "#1d4ed8"
INFO_SOFT = "#e2ecfd"
SIDEBAR = "#ffffff"

_font_cache = {}


def font(size=16, bold=False):
    key = (size, bold)
    if key not in _font_cache:
        path = os.path.join(FONT_DIR, "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf")
        _font_cache[key] = ImageFont.truetype(path, size)
    return _font_cache[key]


def new_canvas(w=1440, h=900):
    img = Image.new("RGB", (w, h), BG)
    return img, ImageDraw.Draw(img)


def rect(d, box, fill=None, outline=None, width=1, radius=12):
    d.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def text(d, xy, s, size=16, bold=False, color=TEXT, anchor="la"):
    d.text(xy, s, font=font(size, bold), fill=color, anchor=anchor)


def text_w(s, size=16, bold=False):
    return font(size, bold).getlength(s)


def pill(d, x, y, label, fg, bg, size=13, padx=12, h=26, bold=True):
    w = text_w(label, size, bold) + padx * 2
    rect(d, (x, y, x + w, y + h), fill=bg, radius=h // 2)
    text(d, (x + padx, y + h / 2), label, size=size, bold=bold, color=fg, anchor="lm")
    return w


def button(d, x, y, label, primary=True, w=None, h=38, icon=None, size=15):
    tw = text_w(label, size, True)
    w = w or tw + 44 + (22 if icon else 0)
    rect(d, (x, y, x + w, y + h), fill=PRIMARY if primary else CARD,
         outline=None if primary else BORDER, radius=9)
    cx = x + w / 2
    text(d, (cx, y + h / 2), (icon + "  " if icon else "") + label, size=size, bold=True,
         color="#ffffff" if primary else TEXT, anchor="mm")
    return w


def input_box(d, x, y, w, label=None, value="", h=40, placeholder=False):
    if label:
        text(d, (x, y - 8), label, size=13, color=MUTED, anchor="ls")
        y += 14
    rect(d, (x, y, x + w, y + h), fill="#ffffff", outline=BORDER, radius=9)
    if value:
        text(d, (x + 14, y + h / 2), value, size=15, color=MUTED if placeholder else TEXT, anchor="lm")
    return y + h


def header(d, title, subtitle="", x=280, w=1160):
    rect(d, (x, 0, x + w, 64), fill="#ffffff")
    d.line((x, 64, x + w, 64), fill=BORDER, width=1)
    text(d, (x + 24, 26), title, size=19, bold=True)
    if subtitle:
        text(d, (x + 24, 47), subtitle, size=12, color=MUTED)
    # global search + bell + avatar
    sx = x + w - 330
    rect(d, (sx, 16, sx + 150, 48), fill=CARD, outline=BORDER, radius=9)
    text(d, (sx + 14, 32), "Search…", size=13, color=MUTED, anchor="lm")
    d.ellipse((sx + 182, 16, sx + 214, 48), outline=BORDER, fill=CARD)
    text(d, (sx + 198, 32), "3", size=12, bold=True, color=TEXT, anchor="mm")
    d.ellipse((sx + 226, 16, sx + 258, 48), fill=PRIMARY)
    text(d, (sx + 242, 32), "AK", size=12, bold=True, color="#ffffff", anchor="mm")


SIDEBAR_GROUPS = [
    ("Dashboard", ["Dashboard"]),
    ("Masters", ["Items", "Parties", "Warehouses", "Machines", "BOM", "Users & Roles"]),
    ("Sales", ["Enquiries & Quotes", "Sales Orders", "Delivery Challans", "Sales Invoices",
               "Sales Returns", "Payment In / Out"]),
    ("Purchase", ["Requisitions", "Purchase Orders", "GRN", "Purchase Invoices", "Purchase Returns"]),
    ("Inventory", ["Stock", "Transfers & Adjustments"]),
    ("Manufacturing", ["Work Orders", "Material Issues", "Production Entries", "MRP", "QC Inspections"]),
    ("Finance", ["Outstanding", "Cash & Bank", "Expenses", "GST Reports", "Reports Center"]),
    ("Utilities", ["Import Center"]),
    ("Admin", ["Settings", "Notifications", "Audit Log"]),
]


def sidebar(d, active="Dashboard", open_group="Dashboard", h=900, x0=0, w=280, compact=False,
            show_close=False):
    rect(d, (x0, 0, x0 + w, h), fill=SIDEBAR, radius=0)
    d.line((x0 + w, 0, x0 + w, h), fill=BORDER, width=1)
    # brand
    rect(d, (x0 + 20, 18, x0 + 52, 50), fill=PRIMARY, radius=9)
    text(d, (x0 + 36, 34), "M", size=17, bold=True, color="#ffffff", anchor="mm")
    text(d, (x0 + 62, 26), "ManuFlow ERP", size=15, bold=True)
    text(d, (x0 + 62, 43), "Manufacturing SaaS Suite", size=10, color=MUTED)
    if show_close:
        rect(d, (x0 + w - 52, 22, x0 + w - 20, 54), fill=CARD, outline=BORDER, radius=8)
        text(d, (x0 + w - 36, 38), "×", size=20, bold=True, color=MUTED, anchor="mm")
    y = 74
    for group, mods in SIDEBAR_GROUPS:
        open_ = group == open_group
        if group != "Dashboard":
            text(d, (x0 + 22, y + 10), group.upper(), size=10, bold=True, color=MUTED)
            text(d, (x0 + w - 30, y + 10), "▾" if open_ else "▸", size=10, color=MUTED, anchor="ra")
            y += 26
        if open_:
            for m in mods:
                is_active = m == active
                if is_active:
                    rect(d, (x0 + 12, y, x0 + w - 12, y + 30), fill=PRIMARY, radius=7)
                elif group == "Dashboard":
                    rect(d, (x0 + 12, y, x0 + w - 12, y + 30), fill="#f1f5f3", radius=7)
                text(d, (x0 + 26, y + 15), m, size=12.5, bold=is_active,
                     color="#ffffff" if is_active else (TEXT if is_active else "#334155"), anchor="lm")
                y += 30
        y += 4
    return y


def kpi_card(d, x, y, w, h, title, value, sub="", tone=PRIMARY, dot=None):
    rect(d, (x, y, x + w, y + h), fill=CARD, outline=BORDER, radius=14)
    rect(d, (x, y, x + 4, y + h), fill=tone, radius=2)
    text(d, (x + 20, y + 20), title, size=12, color=MUTED)
    text(d, (x + 20, y + 44), value, size=24, bold=True)
    if sub:
        text(d, (x + 20, y + 80), sub, size=11, color=MUTED)


def table(d, x, y, w, cols, rows, row_h=44, head_h=42, badges=None, highlight_rows=(), sizes=13):
    """cols: [(title, width_fraction, align)] ; rows: list[list[str]] ; badges: {(r,c):(label,fg,bg)}"""
    rect(d, (x, y, x + w, y + head_h + row_h * len(rows) + 6), fill=CARD, outline=BORDER, radius=12)
    rect(d, (x, y, x + w, y + head_h), fill="#f1f5f3", radius=12)
    rect(d, (x, y + head_h - 8, x + w, y + head_h), fill="#f1f5f3", radius=0)
    cx = x
    for title, frac, align in cols:
        cw = int(w * frac)
        tx = cx + 16 if align == "left" else cx + cw - 16
        text(d, (tx, y + head_h / 2), title, size=11, bold=True, color=MUTED,
             anchor="lm" if align == "left" else "rm")
        cx += cw
    ry = y + head_h
    for ri, row in enumerate(rows):
        if ri in highlight_rows:
            rect(d, (x + 1, ry, x + w - 1, ry + row_h), fill=WARN_SOFT, radius=0)
        d.line((x, ry, x + w, ry), fill=BORDER, width=1)
        cx = x
        for ci, (title, frac, align) in enumerate(cols):
            cw = int(w * frac)
            cell = row[ci] if ci < len(row) else ""
            badge = (badges or {}).get((ri, ci))
            if badge:
                label, fg, bg = badge
                bw = text_w(label, 11, True) + 20
                bx = cx + 12 if align == "left" else cx + cw - 12 - bw
                pill(d, bx, ry + (row_h - 24) / 2, label, fg, bg, size=11, h=24)
            else:
                tx = cx + 16 if align == "left" else cx + cw - 16
                text(d, (tx, ry + row_h / 2), cell, size=sizes,
                     bold=(ci == 0), color=TEXT if ci == 0 else "#334155",
                     anchor="lm" if align == "left" else "rm")
            cx += cw
        ry += row_h
    return ry


def callout(d, x, y, n, label=None, color=DANGER):
    d.ellipse((x - 15, y - 15, x + 15, y + 15), fill=color, outline="#ffffff", width=3)
    text(d, (x, y), str(n), size=14, bold=True, color="#ffffff", anchor="mm")
    if label:
        tw = text_w(label, 12, True) + 24
        rect(d, (x + 22, y - 14, x + 22 + tw, y + 14), fill=color, radius=7)
        text(d, (x + 34, y), label, size=12, bold=True, color="#ffffff", anchor="lm")


def section_card(d, x, y, w, h, title, subtitle=""):
    rect(d, (x, y, x + w, y + h), fill=CARD, outline=BORDER, radius=14)
    text(d, (x + 20, y + 22), title.upper(), size=11, bold=True, color=MUTED)
    if subtitle:
        text(d, (x + 20, y + 42), subtitle, size=11, color=MUTED)


def bar_chart(d, x, y, w, h, values, labels, color=PRIMARY):
    rect(d, (x, y, x + w, y + h), fill="#fbfdfc", outline=BORDER, radius=10)
    maxv = max(values) or 1
    n = len(values)
    slot = w / n
    for i, v in enumerate(values):
        bh = (h - 56) * v / maxv
        bx = x + slot * i + slot * 0.22
        bw = slot * 0.56
        rect(d, (bx, y + h - 34 - bh, bx + bw, y + h - 34), fill=color, radius=6)
        text(d, (bx + bw / 2, y + h - 20), labels[i], size=10, color=MUTED, anchor="mm")


def phone(d, x, y, w=390, h=780, screen=None):
    rect(d, (x, y, x + w, y + h), fill="#0f172a", radius=44)
    rect(d, (x + 10, y + 10, x + w - 10, y + h - 10), fill=BG, radius=36)
    # status bar + notch
    rect(d, (x + w / 2 - 50, y + 10, x + w / 2 + 50, y + 34), fill="#0f172a", radius=12)
    text(d, (x + 28, y + 30), "9:41", size=11, bold=True, color=TEXT)
    text(d, (x + w - 28, y + 30), "5G  ▮", size=10, color=TEXT, anchor="ra")
    return (x + 10, y + 40, x + w - 10, y + h - 10)


def save(img, name):
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots", name)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    img.save(out, "PNG", optimize=True)
    print("saved", out, img.size)
