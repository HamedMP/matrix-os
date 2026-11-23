#!/usr/bin/env python3
"""Independent accept-all / reject-all of tracked changes in a .docx, printing plain text.

Usage:
  python accept_all.py <file.docx>            accept every change, print the text
  python accept_all.py <file.docx> --reject   reject every change, print the text
  python accept_all.py <file.docx> --json     print {"accept": ..., "reject": ...}

Text rules (shared with the expected/*.txt golden files): one line per body paragraph in
document order, table cells joined by a tab and one line per table row, w:tab -> "\t",
w:br / w:cr -> "\n", field instructions are hidden and field results shown. A paragraph
whose mark is removed (deleted mark on accept, inserted mark on reject, moved-away mark)
joins the following paragraph.
"""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from ooxml_package import PackageError, load_package, main_part  # noqa: E402

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
MC = "http://schemas.openxmlformats.org/markup-compatibility/2006"


def _w(tag: str) -> str:
    return f"{{{W}}}{tag}"


RANGE_MARKERS = [_w(t) for t in ("moveFromRangeStart", "moveFromRangeEnd", "moveToRangeStart", "moveToRangeEnd")]
PROPERTY_CHANGES = [_w(t) for t in ("rPrChange", "pPrChange", "sectPrChange", "tblPrChange", "trPrChange",
                                    "tcPrChange", "tblGridChange", "numberingChange")]


def _remove(element) -> None:
    parent = element.getparent()
    if parent is not None:
        parent.remove(element)


def _unwrap(element) -> None:
    parent = element.getparent()
    if parent is None:
        return
    index = parent.index(element)
    for child in list(element):
        parent.insert(index, child)
        index += 1
    parent.remove(element)


def _is_mark(element) -> bool:
    parent = element.getparent()
    return parent is not None and parent.tag == _w("rPr") and parent.getparent() is not None \
        and parent.getparent().tag == _w("pPr")


def _row_revision(element) -> bool:
    parent = element.getparent()
    return parent is not None and parent.tag == _w("trPr")


def apply(body, accept: bool):
    """Return a copy of <w:body> with every tracked change accepted or rejected."""
    body = copy.deepcopy(body)
    drop_kinds = ("del", "moveFrom") if accept else ("ins", "moveTo")
    keep_kinds = ("ins", "moveTo") if accept else ("del", "moveFrom")

    for kind in drop_kinds:
        for element in list(body.iter(_w(kind))):
            if element.getparent() is None:
                continue
            if _is_mark(element):
                element.getparent().getparent().getparent().set("mergeWithNext", "1")
                _remove(element)
            elif _row_revision(element):
                row = element.getparent().getparent()
                _remove(row)
            else:
                _remove(element)
    for kind in keep_kinds:
        for element in list(body.iter(_w(kind))):
            if element.getparent() is None:
                continue
            if _is_mark(element) or _row_revision(element):
                _remove(element)
            else:
                _unwrap(element)
    for tag in RANGE_MARKERS + PROPERTY_CHANGES:
        for element in list(body.iter(tag)):
            _remove(element)
    if not accept:
        for element in body.iter(_w("delText")):
            element.tag = _w("t")
        for element in body.iter(_w("delInstrText")):
            element.tag = _w("instrText")
    return body


def _run_text(paragraph) -> str:
    out: list[str] = []
    field_depth = 0
    hidden_instruction = []  # one bool per open field: True while in its instruction part

    def walk(node):
        nonlocal field_depth
        for child in node:
            tag = child.tag
            if tag == f"{{{MC}}}Fallback" or tag == _w("delText") or tag == _w("instrText") \
                    or tag == _w("delInstrText") or tag == _w("pPr") or tag == _w("rPr"):
                continue
            if tag == _w("fldChar"):
                kind = child.get(_w("fldCharType"))
                if kind == "begin":
                    hidden_instruction.append(True)
                elif kind == "separate" and hidden_instruction:
                    hidden_instruction[-1] = False
                elif kind == "end" and hidden_instruction:
                    hidden_instruction.pop()
                continue
            if any(hidden_instruction):
                walk(child)
                continue
            if tag == _w("t"):
                out.append(child.text or "")
            elif tag == _w("tab"):
                out.append("\t")
            elif tag in (_w("br"), _w("cr")):
                out.append("\n")
            elif tag == _w("noBreakHyphen"):
                out.append("‑")
            elif tag == _w("softHyphen"):
                continue
            else:
                walk(child)

    walk(paragraph)
    return "".join(out)


def _cell_paragraphs(cell) -> list[str]:
    """Paragraph texts of a table cell; a paragraph whose mark was removed joins the next one."""
    texts: list[str] = []
    pending = ""
    for paragraph in cell.findall(_w("p")):
        text = pending + _run_text(paragraph)
        if paragraph.get("mergeWithNext"):
            pending = text
            continue
        pending = ""
        texts.append(text)
    if pending or not texts:
        texts.append(pending)
    return texts


def body_text(body) -> str:
    lines: list[str] = []
    pending = ""  # text of paragraphs whose mark was removed, waiting to join the next one

    for block in body:
        if block.tag == _w("p"):
            text = pending + _run_text(block)
            if block.get("mergeWithNext"):
                pending = text
                continue
            pending = ""
            lines.append(text)
        elif block.tag == _w("tbl"):
            if pending:
                lines.append(pending)
                pending = ""
            for row in block.iter(_w("tr")):
                cells = []
                for cell in row.findall(_w("tc")):
                    cells.append("\n".join(_cell_paragraphs(cell)))
                lines.append("\t".join(cells))
        elif block.tag == _w("sdt"):
            content = block.find(_w("sdtContent"))
            if content is not None:
                lines.append(body_text(content))
    if pending:
        lines.append(pending)
    return "\n".join(lines)


def resolve(path: str) -> dict:
    package = load_package(path)
    document = package.root(main_part(package, "/officeDocument"))
    body = document.find(_w("body"))
    if body is None:
        raise PackageError("document has no <w:body>")
    return {"accept": body_text(apply(body, True)), "reject": body_text(apply(body, False))}


def main(argv: list[str]) -> int:
    files = [a for a in argv[1:] if not a.startswith("--")]
    if len(files) != 1:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    try:
        result = resolve(files[0])
    except PackageError as exc:
        print(f"INVALID {files[0]}: {exc}", file=sys.stderr)
        return 1
    if "--json" in argv:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        print(result["reject" if "--reject" in argv else "accept"])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
