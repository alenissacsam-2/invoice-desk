"""Three extra invoices for uploading live in the demo video (not samples: they never appear in the tray).

A approves, B is voided, C is held. Each uses a vendor/PO no sample touches, so they work in any order.
Run: scripts/.venv/Scripts/python scripts/make_demo_uploads.py   (writes demo-uploads/)
"""
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle

import make_samples as ms
from make_samples import BUYER, SHIP_DOCK, calc, item_rows, lines_at, m, para, table

ms.OUT = Path(__file__).resolve().parent.parent / "demo-uploads"
ms.OUT.mkdir(exist_ok=True)
W, H = ms.letter

# A · Peak Valley, PO-2026-0378 (open, $1,850, services → 2-way match). Expected: APPROVE.
PV = calc([("", "Window & carpet deep clean, Q4 2026 (San Jose HQ, completed Nov 7)", 1, "1850.00")])
# B · Globex Trading Co: vendor V008 is blocked in the master. Expected: REJECT (Vendor blocked).
GX = calc([("SF-18-80", 'Stretch film 18" 80 gauge, 1500 ft roll', 40, "28.50"),
           ("BX-181816", "Corrugated shipping box 18x18x16, 200 lb test", 200, "2.35")])
# C · Acme against PO-2026-0301, which Procurement closed (goods received Jul 21, never billed). Expected: REVIEW → Procurement.
AC = calc([("PAP-A4-80", "A4 copy paper 80gsm, case of 10 reams", 20, "42.50"),
           ("MRK-12AST", "Whiteboard markers assorted 12-pk", 30, "14.20")], tax_rate="0.085")
assert (PV["total"], GX["total"], AC["total"]) == (ms.q2("1850.00"), ms.q2("1610.00"), ms.q2("1384.46"))

small = ParagraphStyle("s", fontName="Helvetica", fontSize=9, leading=12)


def peak_valley_digital():
    green, grey = colors.HexColor("#2F5D3A"), colors.HexColor("#5E6B60")
    c = ms.new_canvas("A_peakvalley_deep_clean.pdf", "Invoice PV-1107", "Peak Valley Janitorial")
    c.setFillColor(green)
    p = c.beginPath(); p.moveTo(40, H - 92); p.lineTo(70, H - 40); p.lineTo(100, H - 92); p.close()
    c.drawPath(p, stroke=0, fill=1)
    c.setFillColor(colors.HexColor("#7FA487"))
    p = c.beginPath(); p.moveTo(76, H - 92); p.lineTo(102, H - 56); p.lineTo(128, H - 92); p.close()
    c.drawPath(p, stroke=0, fill=1)
    lines_at(c, 140, H - 62, ["PEAK VALLEY JANITORIAL"], "Helvetica-Bold", 18, color=green)
    lines_at(c, 140, H - 78, ["Commercial cleaning since 2011"], "Helvetica-Oblique", 9.5, color=grey)
    lines_at(c, W - 40, H - 60, ["INVOICE"], "Helvetica-Bold", 26, color=green, align="r")
    lines_at(c, W - 40, H - 78, ["No. PV-1107"], "Helvetica-Bold", 11, align="r")
    lines_at(c, 40, H - 112, ["412 Alder Street, Milpitas, CA 95035  ·  (408) 555-0167  ·  "
                              "peakvalleyclean@gmail.com  ·  Tax ID 47-5520913"], "Helvetica", 8.5, color=grey)
    c.setStrokeColor(green); c.setLineWidth(2); c.line(40, H - 122, W - 40, H - 122)

    top = H - 148
    lines_at(c, 40, top, ["BILL TO"], "Helvetica-Bold", 8, color=green)
    lines_at(c, 40, top - 15, BUYER + ["Attn: Accounts Payable"], "Helvetica", 10, 13)
    lines_at(c, 220, top, ["SERVICE LOCATION"], "Helvetica-Bold", 8, color=green)
    lines_at(c, 220, top - 15, ["Halden Robotics HQ, all floors", "2150 Junction Ave, San Jose"], "Helvetica", 10, 13)
    meta = [["Invoice date", "November 9, 2026"], ["Your PO", "PO-2026-0378"], ["Terms", "Net 15"],
            ["Due date", "November 24, 2026"]]
    table(c, meta, [80, 105], [("FONT", (0, 0), (0, -1), "Helvetica-Bold", 8.5), ("TEXTCOLOR", (0, 0), (0, -1), green),
                               ("FONT", (1, 0), (1, -1), "Helvetica", 9.5), ("ALIGN", (1, 0), (1, -1), "RIGHT"),
                               ("LINEBELOW", (0, 0), (-1, -1), 0.4, colors.HexColor("#D3DDD5"))], W - 225, top + 4)

    data = [["Service", "Qty", "Rate", "Amount"]] + [[r[1], r[2], r[3], r[4]] for r in item_rows(PV)]
    y = table(c, data, [330, 50, 75, 77], [
        ("BACKGROUND", (0, 0), (-1, 0), green), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 9), ("FONT", (0, 1), (-1, -1), "Helvetica", 9.5),
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"), ("TOPPADDING", (0, 0), (-1, -1), 7), ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
        ("LINEBELOW", (0, -1), (-1, -1), 0.8, green)], 40, H - 262)
    table(c, [["Subtotal", m(PV["subtotal"])], ["Sales tax (services, exempt)", "0.00"], ["TOTAL DUE (USD)", "$" + m(PV["total"])]],
          [150, 77], [("FONT", (0, 0), (-1, -2), "Helvetica", 9.5), ("ALIGN", (1, 0), (1, -1), "RIGHT"),
                      ("FONT", (0, -1), (-1, -1), "Helvetica-Bold", 11), ("LINEABOVE", (0, -1), (-1, -1), 1, green),
                      ("TOPPADDING", (0, -1), (-1, -1), 7)], W - 40 - 227, y - 8)
    by = y - 120
    lines_at(c, 40, by, ["PAYMENT"], "Helvetica-Bold", 8, color=green)
    lines_at(c, 40, by - 15, ["ACH to Peak Valley Janitorial", "Chase Bank · Routing 322271627 · Account 5582019934",
                              "Please quote PV-1107 with your payment."], "Helvetica", 9, 12.5)
    lines_at(c, 330, by, ["NOTES"], "Helvetica-Bold", 8, color=green)
    para(c, "Deep clean of all windows and carpeted areas completed Saturday, November 7. Crew of 4, 9 hours. "
            "Thank you for choosing Peak Valley.", 330, by - 7, W - 370, small)
    c.save()


def globex():
    orange, ink = colors.HexColor("#C4501B"), colors.HexColor("#222222")
    c = ms.new_canvas("B_globex_blocked_vendor.pdf", "Invoice GTC-58213", "Globex Trading Co")
    c.setFillColor(ink); c.rect(0, H - 70, W, 70, stroke=0, fill=1)
    c.setFillColor(orange); c.circle(62, H - 35, 20, stroke=0, fill=1)
    lines_at(c, 62, H - 41, ["G"], "Helvetica-Bold", 18, color=colors.white, align="c")
    lines_at(c, 94, H - 32, ["GLOBEX TRADING CO"], "Helvetica-Bold", 16, color=colors.white)
    lines_at(c, 94, H - 48, ["Industrial packaging · Warehouse consumables"], "Helvetica", 9, color=colors.HexColor("#BBBBBB"))
    lines_at(c, W - 40, H - 44, ["TAX INVOICE"], "Helvetica-Bold", 20, color=orange, align="r")
    lines_at(c, 40, H - 92, ["88 NW 27th Avenue, Miami, FL 33125  |  (305) 555-0101  |  ar@globextrading.com  |  "
                             "EIN 61-7733095"], "Helvetica", 8.5, color=colors.HexColor("#555555"))
    top = H - 125
    meta = [["Invoice No.", "GTC-58213"], ["Date", "November 7, 2026"], ["Order ref.", "Email order of Oct 30"],
            ["Terms", "Net 30"], ["Due", "December 7, 2026"]]
    table(c, [["SOLD TO", "SHIP TO"], ["\n".join(BUYER), "\n".join(SHIP_DOCK)]], [170, 170],
          [("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 8), ("TEXTCOLOR", (0, 0), (-1, 0), orange),
           ("FONT", (0, 1), (-1, 1), "Helvetica", 9.5), ("VALIGN", (0, 1), (-1, 1), "TOP")], 40, top)
    table(c, meta, [75, 120], [("FONT", (0, 0), (0, -1), "Helvetica-Bold", 8.5), ("FONT", (1, 0), (1, -1), "Helvetica", 9.5),
                               ("ALIGN", (1, 0), (1, -1), "RIGHT"), ("BOX", (0, 0), (-1, -1), 0.8, ink),
                               ("LINEBELOW", (0, 0), (-1, -2), 0.3, colors.HexColor("#CCCCCC"))], W - 235, top)
    data = [["SKU", "Description", "Qty", "Unit", "Total"]] + item_rows(GX)
    y = table(c, data, [70, 260, 50, 70, 82], [
        ("LINEBELOW", (0, 0), (-1, 0), 1.2, ink), ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 9),
        ("FONT", (0, 1), (-1, -1), "Helvetica", 9.5), ("ALIGN", (2, 0), (-1, -1), "RIGHT"),
        ("LINEBELOW", (0, 1), (-1, -1), 0.3, colors.HexColor("#CCCCCC")), ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6)], 40, H - 250)
    table(c, [["Subtotal", m(GX["subtotal"])], ["Sales tax (out of state)", "0.00"], ["AMOUNT DUE USD", m(GX["total"])]],
          [140, 82], [("FONT", (0, 0), (-1, -2), "Helvetica", 9.5), ("ALIGN", (1, 0), (1, -1), "RIGHT"),
                      ("FONT", (0, -1), (-1, -1), "Helvetica-Bold", 11), ("BACKGROUND", (0, -1), (-1, -1), orange),
                      ("TEXTCOLOR", (0, -1), (-1, -1), colors.white), ("TOPPADDING", (0, -1), (-1, -1), 7),
                      ("BOTTOMPADDING", (0, -1), (-1, -1), 7)], W - 40 - 222, y - 8)
    by = y - 110
    lines_at(c, 40, by, ["REMITTANCE"], "Helvetica-Bold", 8, color=orange)
    lines_at(c, 40, by - 15, ["Globex Trading Co", "Bank of America · ABA 026009593 · Acct 0098123344"],
             "Helvetica", 9, 12.5)
    lines_at(c, W / 2, 40, ["Goods remain property of Globex Trading Co until paid in full."],
             "Helvetica-Oblique", 8, color=colors.HexColor("#777777"), align="c")
    c.save()


def acme_closed_po():
    navy, grey = colors.HexColor("#1F3A68"), colors.HexColor("#5B6573")
    c = ms.new_canvas("C_acme_closed_po.pdf", "Invoice ACM-INV-10512", "Acme Office Supplies LLC")
    c.setFillColor(navy); c.rect(0, H - 92, W, 92, stroke=0, fill=1)
    c.setFillColor(colors.white); c.roundRect(40, H - 70, 44, 44, 6, stroke=0, fill=1)
    c.setFillColor(navy); c.setFont("Helvetica-Bold", 28); c.drawCentredString(62, H - 58, "A")
    lines_at(c, 96, H - 46, ["ACME OFFICE SUPPLIES LLC"], "Helvetica-Bold", 16, color=colors.white)
    lines_at(c, 96, H - 62, ["Office furniture · Paper · Workplace supplies"], "Helvetica", 9, color=colors.HexColor("#C9D4E6"))
    lines_at(c, W - 40, H - 58, ["INVOICE"], "Helvetica-Bold", 30, color=colors.white, align="r")
    lines_at(c, 40, H - 110, ["1840 Industrial Parkway, Hayward, CA 94545   |   (510) 555-0142   |   "
                              "ar@acmeofficesupply.com   |   EIN 84-2917365"], "Helvetica", 8.5, color=grey)
    top = H - 140
    for x, label, body in ((40, "BILL TO", BUYER + ["Accounts Payable"]), (210, "SHIP TO", SHIP_DOCK)):
        lines_at(c, x, top, [label], "Helvetica-Bold", 8, color=navy)
        lines_at(c, x, top - 15, body, "Helvetica", 10, 13)
    meta = [["Invoice #", "ACM-INV-10512"], ["Invoice Date", "November 6, 2026"], ["PO Number", "PO-2026-0301"],
            ["Customer No.", "HAL-0042"], ["Terms", "Net 30"], ["Due Date", "December 6, 2026"]]
    table(c, meta, [80, 110], [("FONT", (0, 0), (0, -1), "Helvetica-Bold", 8.5), ("TEXTCOLOR", (0, 0), (0, -1), navy),
                               ("FONT", (1, 0), (1, -1), "Helvetica", 9.5), ("ALIGN", (1, 0), (1, -1), "RIGHT"),
                               ("LINEBELOW", (0, 0), (-1, -1), 0.4, colors.HexColor("#D5DBE5")),
                               ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#EEF2F8")),
                               ("FONT", (1, 0), (1, 0), "Helvetica-Bold", 9.5)], W - 230, top + 4)
    data = [["Item #", "Description", "Qty", "Unit Price", "Amount"]] + item_rows(AC)
    y = table(c, data, [82, 240, 50, 75, 85], [
        ("BACKGROUND", (0, 0), (-1, 0), navy), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 9), ("FONT", (0, 1), (-1, -1), "Helvetica", 9.5),
        ("ALIGN", (2, 0), (-1, -1), "RIGHT"), ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F4F6FA")]),
        ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LINEBELOW", (0, -1), (-1, -1), 0.8, navy)], 40, H - 262)
    table(c, [["Subtotal", m(AC["subtotal"])], ["Sales Tax (8.5%)", m(AC["tax"])], ["TOTAL DUE (USD)", "$" + m(AC["total"])]],
          [120, 85], [("FONT", (0, 0), (-1, -2), "Helvetica", 9.5), ("ALIGN", (1, 0), (1, -1), "RIGHT"),
                      ("FONT", (0, -1), (-1, -1), "Helvetica-Bold", 11), ("BACKGROUND", (0, -1), (-1, -1), navy),
                      ("TEXTCOLOR", (0, -1), (-1, -1), colors.white), ("TOPPADDING", (0, -1), (-1, -1), 7),
                      ("BOTTOMPADDING", (0, -1), (-1, -1), 7)], W - 40 - 205, y - 8)
    by = y - 120
    lines_at(c, 40, by, ["REMIT TO"], "Helvetica-Bold", 8, color=navy)
    lines_at(c, 40, by - 15, ["Acme Office Supplies LLC", "Wells Fargo Bank, N.A.", "ABA Routing: 121000248",
                              "Account No.: 4411223344"], "Helvetica", 9, 12.5)
    lines_at(c, 330, by, ["NOTES"], "Helvetica-Bold", 8, color=navy)
    para(c, "Goods delivered July 21, 2026 (packing slip 75310). This invoice was held in our system in error; "
            "apologies for the late billing.", 330, by - 7, W - 370, small)
    c.setStrokeColor(navy); c.setLineWidth(2); c.line(40, 60, W - 40, 60)
    lines_at(c, W / 2, 44, ["Thank you for your business!  Questions? ar@acmeofficesupply.com · (510) 555-0142"],
             "Helvetica-Oblique", 8.5, color=grey, align="c")
    c.save()


if __name__ == "__main__":
    peak_valley_digital(); globex(); acme_closed_po()
    print("wrote", sorted(p.name for p in ms.OUT.iterdir()))
