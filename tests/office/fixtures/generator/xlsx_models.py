"""multi-sheet.xlsx, model.xlsx and data.csv."""

from __future__ import annotations

import csv
import datetime as dt
import io

from openpyxl.styles import Font
from openpyxl.utils import get_column_letter

from .xlsx_fixtures import _new_workbook
from .xlsx_package import save

MODEL = {
    "start_revenue": 50000,
    "growth": 0.03,
    "cogs": 0.40,
    "opex": 18000,
    "tax": 0.25,
    "hard_coded_total_revenue": 725000,
}


def multi_sheet() -> bytes:
    wb = _new_workbook()
    summary = wb.active
    summary.title = "Summary"
    q1 = wb.create_sheet("Q1 Sales")
    q2 = wb.create_sheet("Q2 Sales")
    notes = wb.create_sheet("O'Brien Notes")
    lookup = wb.create_sheet("Hidden Lookup")
    lookup.sheet_state = "hidden"
    q1.sheet_properties.tabColor = "2E75B6"
    q2.sheet_properties.tabColor = "70AD47"

    regions = ["North", "South", "East", "West"]
    q1_values = [120, 95, 143, 88]
    q2_values = [131, 102, 139, 97]
    for ws, values in ((q1, q1_values), (q2, q2_values)):
        ws.append(["Region", "Units"])
        for region, value in zip(regions, values):
            ws.append([region, value])
        ws.append(["Total", "=SUM(B2:B5)"])
    notes["A1"] = "Figures checked by the regional leads."
    notes["A2"] = "Q2 East includes a late return of 6 units."
    lookup.append(["Code", "Region"])
    for code, region in zip(["N", "S", "E", "W"], regions):
        lookup.append([code, region])

    summary.append(["Metric", "Value"])
    summary.append(["Q1 total units", "='Q1 Sales'!B6"])
    summary.append(["Q2 total units", "='Q2 Sales'!B6"])
    summary.append(["Half-year units", "=SUM('Q1 Sales'!B2:B5,'Q2 Sales'!B2:B5)"])
    summary.append(["Growth Q1 to Q2", "=B3/B2-1"])
    summary.append(["Region for code E", "=VLOOKUP(\"E\",'Hidden Lookup'!A2:B5,2,FALSE)"])
    summary.append(["Note", "='O''Brien Notes'!A1"])
    summary["B5"].number_format = "0.0%"
    t1, t2 = sum(q1_values), sum(q2_values)
    cached = {
        "Q1 Sales": {"B6": t1},
        "Q2 Sales": {"B6": t2},
        "Summary": {"B2": t1, "B3": t2, "B4": t1 + t2, "B5": t2 / t1 - 1, "B6": "East",
                    "B7": "Figures checked by the regional leads."},
    }
    return save(wb, cached)


def model_values() -> dict:
    months = []
    revenue = MODEL["start_revenue"]
    for index in range(12):
        if index:
            revenue = revenue * (1 + MODEL["growth"])
        cogs = revenue * MODEL["cogs"]
        gross = revenue - cogs
        opex = MODEL["opex"]
        ebit = gross - opex
        tax = max(0, ebit * MODEL["tax"])
        months.append({"revenue": revenue, "cogs": cogs, "gross": gross, "opex": opex, "ebit": ebit,
                       "tax": tax, "net": ebit - tax})
    return {"months": months, "totals": {k: sum(m[k] for m in months) for k in months[0]}}


def model() -> bytes:
    wb = _new_workbook()
    assumptions = wb.active
    assumptions.title = "Assumptions"
    projection = wb.create_sheet("Projection")
    summary = wb.create_sheet("Summary")

    assumptions.append(["Assumption", "Value", "Unit"])
    assumptions.append(["Starting monthly revenue", MODEL["start_revenue"], "GBP"])
    assumptions.append(["Monthly revenue growth", MODEL["growth"], "%"])
    assumptions.append(["Cost of sales", MODEL["cogs"], "% of revenue"])
    assumptions.append(["Monthly operating costs", MODEL["opex"], "GBP"])
    assumptions.append(["Corporation tax rate", MODEL["tax"], "%"])
    for row in (3, 4, 6):
        assumptions[f"B{row}"].number_format = "0.0%"
    assumptions["A1"].font = assumptions["B1"].font = assumptions["C1"].font = Font(bold=True)

    values = model_values()
    projection["A1"] = "12-month projection (GBP)"
    projection["A1"].font = Font(bold=True, size=13)
    projection["A3"] = "Line"
    lines = [("Revenue", 4), ("Cost of sales", 5), ("Gross profit", 6), ("Operating costs", 7),
             ("Operating profit", 8), ("Tax", 9), ("Net income", 10)]
    for label, row in lines:
        projection[f"A{row}"] = label
    keys = ["revenue", "cogs", "gross", "opex", "ebit", "tax", "net"]
    cached: dict[str, object] = {}
    for index in range(12):
        col = get_column_letter(index + 2)
        prev = get_column_letter(index + 1)
        projection[f"{col}3"] = dt.date(2027, index + 1, 1)
        projection[f"{col}3"].number_format = "mmm yyyy"
        projection[f"{col}4"] = "=Assumptions!$B$2" if index == 0 else f"={prev}4*(1+Assumptions!$B$3)"
        projection[f"{col}5"] = f"={col}4*Assumptions!$B$4"
        projection[f"{col}6"] = f"={col}4-{col}5"
        projection[f"{col}7"] = "=Assumptions!$B$5"
        projection[f"{col}8"] = f"={col}6-{col}7"
        projection[f"{col}9"] = f"=MAX(0,{col}8*Assumptions!$B$6)"
        projection[f"{col}10"] = f"={col}8-{col}9"
        for key, (_, row) in zip(keys, lines):
            cached[f"{col}{row}"] = values["months"][index][key]
            projection[f"{col}{row}"].number_format = "#,##0"
    projection["N3"] = "Total"
    for key, (_, row) in zip(keys, lines):
        projection[f"N{row}"] = f"=SUM(B{row}:M{row})"
        projection[f"N{row}"].number_format = "#,##0"
        cached[f"N{row}"] = values["totals"][key]
    projection.freeze_panes = "B4"

    summary.append(["Summary", "Value", "Source"])
    summary.append(["Total revenue", MODEL["hard_coded_total_revenue"], "Board pack (typed in)"])
    summary.append(["Total net income", "=Projection!N10", "Projection"])
    summary.append(["Net margin", "=B3/Projection!N4", "Projection"])
    summary.append(["Average monthly operating costs", "=AVERAGE(Projection!B7:M7)", "Projection"])
    summary["B2"].number_format = summary["B3"].number_format = summary["B5"].number_format = "#,##0"
    summary["B4"].number_format = "0.0%"
    totals = values["totals"]
    summary_cached = {"B3": totals["net"], "B4": totals["net"] / totals["revenue"], "B5": MODEL["opex"]}
    return save(wb, {"Projection": cached, "Summary": summary_cached})


def data_csv() -> bytes:
    rows = [
        ["id", "name", "email", "signup_date", "plan", "amount", "notes"],
        ["1", "Ana Lima", "ana@example.com", "2026-01-04", "pro", "49.00", ""],
        ["2", "Ben Carter", "ben@example.com", "2026-01-09", "free", "0", "Asked about \"team\" pricing"],
        ["3", "Chloé Martin", "chloe@example.com", "2026-02-11", "pro", "49.00", "Paris, France"],
        ["4", "Dev Patel", "dev@example.com", "2026-02-28", "team", "199.50", "Multi-line\nnote"],
        ["5", "李华", "li@example.com", "2026-03-03", "pro", "49.00", "Unicode name"],
        ["6", "Eve Adams", "", "2026-03-15", "free", "", "Missing email and amount"],
        ["7", "Frank O'Neil", "frank@example.com", "2026-04-01", "team", "1,250.00", "Amount with thousands separator"],
        ["8", "Grace Ho", "grace@example.com", "2026-04-20", "pro", "-10.00", "Refund"],
    ]
    buffer = io.StringIO()
    csv.writer(buffer, lineterminator="\n").writerows(rows)
    return buffer.getvalue().encode("utf-8")
