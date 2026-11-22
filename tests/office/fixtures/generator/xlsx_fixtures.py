"""basic.xlsx, formulas.xlsx and formats.xlsx.

Every formula's result is computed here and passed to ``save``, which stores it as the
cached value, as a spreadsheet application would.
"""

from __future__ import annotations

import datetime as dt

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.workbook.defined_name import DefinedName
from openpyxl.worksheet.formula import ArrayFormula

from .ooxml import FIXED_DATE
from .xlsx_package import save


def _new_workbook() -> Workbook:
    wb = Workbook()
    wb.properties.creator = "Matrix OS fixtures"
    wb.properties.created = FIXED_DATE
    wb.properties.modified = FIXED_DATE
    wb.properties.lastModifiedBy = "Matrix OS fixtures"
    return wb


def basic() -> bytes:
    wb = _new_workbook()
    ws = wb.active
    ws.title = "Basics"
    ws.append(["Label", "Value", "Kind"])
    rows = [
        ("Integer", 42, "number"), ("Negative", -17, "number"), ("Decimal", 3.14159, "number"),
        ("Large", 1234567890123, "number"), ("Text", "hello world", "string"),
        ("Repeated", "hello world", "string"), ("Unicode", "Grüße – 文档 \U0001F600", "string"),
        ("True", True, "boolean"), ("False", False, "boolean"),
        ("Date", dt.date(2026, 3, 14), "date"), ("Date time", dt.datetime(2026, 3, 14, 15, 9, 26), "datetime"),
        ("Leading zero text", "00123", "string"), ("Long text", "Lorem ipsum " * 20, "string"),
    ]
    for row in rows:
        ws.append(list(row))
    ws["E2"] = "Gap after an empty column"
    ws["A20"] = "Isolated cell below empty rows"
    ws.append(["Inline", "Inline string cell", "inline string"])
    return save(wb, {}, keep_inline={"Inline string cell"})


def formulas() -> bytes:
    wb = _new_workbook()
    data = wb.active
    data.title = "Data"
    calc = wb.create_sheet("Calc")
    products = [("SKU-001", "Gadget", 12.5, 40), ("SKU-002", "Widget", 8.25, 25), ("SKU-003", "Gizmo", 19.99, 12),
                ("SKU-004", "Doohickey", 4.75, 60), ("SKU-005", "Sprocket", 2.4, 100)]
    data.append(["SKU", "Product", "Price", "Qty", "Line total", "Line total incl. tax"])
    tax = 0.2
    cached_data: dict[str, object] = {}
    for row, (sku, name, price, qty) in enumerate(products, start=2):
        data.append([sku, name, price, qty, f"=C{row}*D{row}", f"=E{row}*(1+Calc!$B$6)"])
        cached_data[f"E{row}"] = price * qty
        cached_data[f"F{row}"] = price * qty * (1 + tax)

    total_qty = sum(p[3] for p in products)
    revenue = sum(p[2] * p[3] for p in products)
    rows = [
        ("Total qty", "=SUM(Data!D2:D6)", total_qty),
        ("Average price", "=AVERAGE(Data!C2:C6)", sum(p[2] for p in products) / len(products)),
        ("Big order?", '=IF(B1>100,"Yes","No")', "Yes" if total_qty > 100 else "No"),
        ("Price of SKU-003", '=VLOOKUP("SKU-003",Data!A2:C6,3,FALSE)', 19.99),
        ("Qty of Widget", '=INDEX(Data!D2:D6,MATCH("Widget",Data!B2:B6,0))', 25),
        ("Tax rate", tax, None),
        ("Revenue", "=SUMPRODUCT(Data!C2:C6,Data!D2:D6)", revenue),
        ("Revenue incl. tax", "=B7*(1+TaxRate)", revenue * (1 + tax)),
        ("More than 50 items?", "=B1>50", total_qty > 50),
        ("Missing SKU", '=VLOOKUP("SKU-999",Data!A2:C6,3,FALSE)', "#N/A"),
        ("Grand total of line totals", "=SUM(Data!$E$2:$E$6)", sum(p[2] * p[3] for p in products)),
    ]
    cached_calc: dict[str, object] = {}
    for index, (label, value, result) in enumerate(rows, start=1):
        calc[f"A{index}"] = label
        calc[f"B{index}"] = value
        if result is not None:
            cached_calc[f"B{index}"] = result
    calc["D1"] = "Array of line totals"
    calc["D2"] = ArrayFormula("D2:D6", "=Data!C2:C6*Data!D2:D6")
    cached_calc["D2"] = products[0][2] * products[0][3]
    for offset, product in enumerate(products[1:], start=3):
        calc[f"D{offset}"] = product[2] * product[3]  # cached members of the array range
    wb.defined_names["TaxRate"] = DefinedName("TaxRate", attr_text="Calc!$B$6")
    return save(wb, {"Data": cached_data, "Calc": cached_calc})


def formats() -> bytes:
    wb = _new_workbook()
    ws = wb.active
    ws.title = "Formats"
    ws.merge_cells("A1:F1")
    ws["A1"] = "Formatted values"
    ws["A1"].font = Font(name="Arial", size=16, bold=True, color="FFFFFF")
    ws["A1"].fill = PatternFill("solid", fgColor="1F3A5F")
    ws["A1"].alignment = Alignment(horizontal="center", vertical="center")
    ws.row_dimensions[1].height = 28
    ws.append(["Kind", "Value", "Format", "Note"])
    for cell in ws[2]:
        cell.font = Font(bold=True)
        cell.border = Border(bottom=Side(style="thick"))
    samples = [
        ("Currency (USD)", 1234.5, '"$"#,##0.00_);[Red]("$"#,##0.00)'),
        ("Currency (GBP)", -987.65, '"£"#,##0.00'),
        ("Currency (EUR)", 50000, '#,##0.00 [$€-x-euro2]'),
        ("Percent", 0.1275, "0.0%"),
        ("Date ISO", dt.date(2026, 7, 4), "yyyy-mm-dd"),
        ("Date long", dt.date(2026, 12, 25), "d mmmm yyyy"),
        ("Time", dt.time(14, 30), "h:mm AM/PM"),
        ("Zero padded", 42, "00000"),
        ("Thousands, red negative", -15000, "#,##0;[Red]-#,##0"),
        ("Scientific", 0.000123, "0.00E+00"),
        ("Fraction", 0.75, "# ?/?"),
        ("Text format", "007", "@"),
    ]
    thin = Side(style="thin", color="999999")
    for kind, value, fmt in samples:
        ws.append([kind, value, fmt, None])
        cell = ws.cell(row=ws.max_row, column=2)
        cell.number_format = fmt
        cell.border = Border(left=thin, right=thin, top=thin, bottom=thin)
    ws["D3"] = "Wrapped text that is long enough to need several lines in a narrow column"
    ws["D3"].alignment = Alignment(wrap_text=True, vertical="top")
    ws["D4"] = "Italic, coloured, underlined"
    ws["D4"].font = Font(italic=True, underline="single", color="C00000", name="Georgia")
    ws["D5"] = "Rotated"
    ws["D5"].alignment = Alignment(text_rotation=45)
    ws["D6"] = "Yellow fill, double border"
    ws["D6"].fill = PatternFill("solid", fgColor="FFF2CC")
    ws["D6"].border = Border(bottom=Side(style="double"))
    ws["D7"] = "Right aligned, indented"
    ws["D7"].alignment = Alignment(horizontal="right", indent=2)
    ws.merge_cells("E3:F5")
    ws["E3"] = "Merged block"
    ws["E3"].alignment = Alignment(horizontal="center", vertical="center")
    for column, width in {"A": 26, "B": 18, "C": 34, "D": 30, "E": 12, "F": 12}.items():
        ws.column_dimensions[column].width = width
    ws.freeze_panes = "B3"
    return save(wb, {})
