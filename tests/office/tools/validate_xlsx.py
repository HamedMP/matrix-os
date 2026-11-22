#!/usr/bin/env python3
"""Independently validate a .xlsx file and print a JSON summary.

Usage: python validate_xlsx.py <file.xlsx> [--quiet] [--max-formulas N]

Exit codes: 0 valid, 1 invalid (reason in JSON "errors" and on stderr), 2 usage error.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from ooxml_package import PackageError, load_package, main_part  # noqa: E402

S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS = {"s": S}


def _s(tag: str) -> str:
    return f"{{{S}}}{tag}"


def scan_package(package, workbook_part: str) -> dict:
    """Read sheets, shared strings and raw formulas straight from the XML."""
    workbook = package.root(workbook_part)
    rels = {rel["id"]: rel for rel in package.rels_for(workbook_part)}
    shared_count = 0
    for rel in rels.values():
        if rel["type"].endswith("/sharedStrings") and "resolved" in rel:
            shared_count = len(package.root(rel["resolved"]).findall("s:si", NS))
    sheets = []
    errors: list[str] = []
    for sheet in workbook.iterfind("s:sheets/s:sheet", NS):
        rel_id = sheet.get(f"{{{R}}}id")
        rel = rels.get(rel_id)
        if rel is None or "resolved" not in rel:
            errors.append(f"sheet {sheet.get('name')!r} has no worksheet relationship {rel_id}")
            continue
        root = package.root(rel["resolved"])
        cells = list(root.iterfind("s:sheetData/s:row/s:c", NS))
        formulas = []
        uncached = 0
        for cell in cells:
            formula = cell.find("s:f", NS)
            if formula is None:
                if cell.get("t") == "s":
                    value = cell.findtext("s:v", default="", namespaces=NS)
                    if not value.isdigit() or int(value) >= shared_count:
                        errors.append(f"{sheet.get('name')}!{cell.get('r')} shared string index {value!r} out of range")
                continue
            cached = cell.find("s:v", NS)
            if cached is not None and not (cached.text or ""):
                cached = None
            if cached is None:
                uncached += 1
            formulas.append({
                "cell": cell.get("r"),
                "formula": formula.text or "",
                "type": formula.get("t", "normal"),
                "ref": formula.get("ref"),
                "cached": None if cached is None else cached.text,
            })
        merged = [m.get("ref") for m in root.iterfind("s:mergeCells/s:mergeCell", NS)]
        pane = root.find("s:sheetViews/s:sheetView/s:pane", NS)
        sheets.append({
            "name": sheet.get("name"),
            "state": sheet.get("state", "visible"),
            "part": rel["resolved"],
            "dimension": (root.find("s:dimension", NS).get("ref") if root.find("s:dimension", NS) is not None else None),
            "cells": len(cells),
            "formulaCount": len(formulas),
            "formulasWithoutCachedValue": uncached,
            "formulas": formulas,
            "mergedCells": merged,
            "frozenAt": pane.get("topLeftCell") if pane is not None and pane.get("state") in ("frozen", "frozenSplit") else None,
            "columnWidths": {c.get("min") + (":" + c.get("max") if c.get("max") != c.get("min") else ""): float(c.get("width"))
                             for c in root.iterfind("s:cols/s:col", NS) if c.get("width")},
        })
    defined = {d.get("name"): d.text for d in workbook.iterfind("s:definedNames/s:definedName", NS)}
    return {"sheets": sheets, "sharedStrings": shared_count, "definedNames": defined, "errors": errors}


def validate(path: str, max_formulas: int) -> dict:
    package = load_package(path)
    workbook_part = main_part(package, "/officeDocument")
    content_type = package.content_types.get(workbook_part, "")
    if "spreadsheetml" not in content_type and "ms-excel" not in content_type:
        raise PackageError(f"main part {workbook_part} has content type {content_type}")
    raw = scan_package(package, workbook_part)

    try:
        import openpyxl  # second independent reader
        formulas_wb = openpyxl.load_workbook(path, data_only=False)
        values_wb = openpyxl.load_workbook(path, data_only=True)
    except Exception as exc:  # noqa: BLE001 - any reader failure means the file is invalid
        reason = f"openpyxl could not open the file: {type(exc).__name__}: {exc}"
        if raw["errors"]:  # report the specific XML problems first, then the reader failure
            return {"file": Path(path).name, "valid": False, "errors": [*raw["errors"], reason]}
        raise PackageError(reason) from exc

    errors = list(raw["errors"])
    names = [s["name"] for s in raw["sheets"]]
    if names != formulas_wb.sheetnames:
        errors.append(f"sheet names differ between XML {names} and openpyxl {formulas_wb.sheetnames}")
    for sheet in raw["sheets"]:
        ws = formulas_wb[sheet["name"]]
        values = values_wb[sheet["name"]]
        types: dict[str, int] = {}
        for row in values.iter_rows():
            for cell in row:
                if cell.value is None:
                    continue
                kind = type(cell.value).__name__
                types[kind] = types.get(kind, 0) + 1
        sheet["valueTypes"] = dict(sorted(types.items()))
        sheet["maxRow"] = ws.max_row
        sheet["maxColumn"] = ws.max_column
        del sheet["part"]
        if len(sheet["formulas"]) > max_formulas:
            sheet["formulasTruncated"] = True
            sheet["formulas"] = sheet["formulas"][:max_formulas]
    return {
        "file": Path(path).name,
        "valid": not errors,
        "errors": errors,
        "parts": len(package.parts),
        "sheetNames": names,
        "sharedStrings": raw["sharedStrings"],
        "definedNames": raw["definedNames"],
        "totalCells": sum(s["cells"] for s in raw["sheets"]),
        "totalFormulas": sum(s["formulaCount"] for s in raw["sheets"]),
        "sheets": raw["sheets"],
    }


def main(argv: list[str]) -> int:
    args = argv[1:]
    max_formulas = 200
    if "--max-formulas" in args:
        index = args.index("--max-formulas")
        try:
            max_formulas = int(args[index + 1])
        except (IndexError, ValueError):
            print(__doc__.strip(), file=sys.stderr)
            return 2
        del args[index:index + 2]
    files = [a for a in args if not a.startswith("--")]
    if len(files) != 1:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    try:
        result = validate(files[0], max_formulas)
    except PackageError as exc:
        result = {"file": Path(files[0]).name, "valid": False, "errors": [str(exc)]}
    if "--quiet" not in args:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    if not result["valid"]:
        print(f"INVALID {files[0]}: {'; '.join(result['errors'])}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
