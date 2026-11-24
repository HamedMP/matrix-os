"""Post-process openpyxl output so workbooks look like spreadsheet-application files.

openpyxl 3.1 writes strings inline and formulas without cached results. ``save`` moves
strings into a shared string table (xl/sharedStrings.xml) and stores the computed result
of every formula in its <v> element, then writes a byte-stable ZIP.
"""

from __future__ import annotations

import io
import posixpath
import zipfile

from lxml import etree
from openpyxl import Workbook

from .ooxml import normalize_zip

S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PR = "http://schemas.openxmlformats.org/package/2006/relationships"
CT = "http://schemas.openxmlformats.org/package/2006/content-types"
SST_CT = "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"
SST_REL = f"{R}/sharedStrings"
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"


def _cached_value(value) -> tuple[str | None, str]:
    if isinstance(value, bool):
        return "b", "1" if value else "0"
    if isinstance(value, str) and value.startswith("#"):
        return "e", value
    if isinstance(value, str):
        return "str", value
    if isinstance(value, float):
        return None, str(int(value)) if value.is_integer() else repr(value)
    return None, str(value)


def _serialize(root) -> bytes:
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def _sheet_parts(parts: dict[str, bytes]) -> dict[str, str]:
    workbook = etree.fromstring(parts["xl/workbook.xml"])
    rels = etree.fromstring(parts["xl/_rels/workbook.xml.rels"])
    targets = {rel.get("Id"): rel.get("Target") for rel in rels.iter(f"{{{PR}}}Relationship")}
    result = {}
    for sheet in workbook.iter(f"{{{S}}}sheet"):
        target = targets[sheet.get(f"{{{R}}}id")]
        result[sheet.get("name")] = posixpath.normpath(
            target.lstrip("/") if target.startswith("/") else posixpath.join("xl", target))
    return result


def _fill_cached(root, values: dict[str, object], part: str) -> None:
    for cell in root.iter(f"{{{S}}}c"):
        if cell.find(f"{{{S}}}f") is None:
            continue
        ref = cell.get("r")
        if ref not in values:
            raise ValueError(f"{part} {ref} has a formula but no cached value")
        kind, text = _cached_value(values[ref])
        v = cell.find(f"{{{S}}}v")
        if v is None:
            v = etree.SubElement(cell, f"{{{S}}}v")
        v.text = text
        if kind:
            cell.set("t", kind)
        elif "t" in cell.attrib:
            del cell.attrib["t"]


def _share_strings(root, table: list[str], index: dict[str, int], keep_inline: frozenset[str]) -> int:
    references = 0
    for cell in root.iter(f"{{{S}}}c"):
        if cell.get("t") != "inlineStr":
            continue
        inline = cell.find(f"{{{S}}}is")
        text = "" if inline is None else "".join(t.text or "" for t in inline.iter(f"{{{S}}}t"))
        if text in keep_inline:
            continue
        if text not in index:
            index[text] = len(table)
            table.append(text)
        if inline is not None:
            cell.remove(inline)
        etree.SubElement(cell, f"{{{S}}}v").text = str(index[text])
        cell.set("t", "s")
        references += 1
    return references


def _shared_strings_xml(table: list[str], references: int) -> bytes:
    sst = etree.Element(f"{{{S}}}sst", nsmap={None: S}, count=str(references), uniqueCount=str(len(table)))
    for text in table:
        t = etree.SubElement(etree.SubElement(sst, f"{{{S}}}si"), f"{{{S}}}t")
        t.text = text
        if text != text.strip() or "\n" in text:
            t.set(XML_SPACE, "preserve")
    return _serialize(sst)


def save(wb: Workbook, cached: dict[str, dict[str, object]], keep_inline=frozenset()) -> bytes:
    buffer = io.BytesIO()
    wb.save(buffer)
    with zipfile.ZipFile(io.BytesIO(buffer.getvalue())) as archive:
        parts = {info.filename: archive.read(info) for info in archive.infolist()}

    sheet_parts = _sheet_parts(parts)
    unknown = set(cached) - set(sheet_parts)
    if unknown:
        raise ValueError(f"cached values for unknown sheets: {sorted(unknown)}")
    values_by_part = {sheet_parts[name]: values for name, values in cached.items()}
    table: list[str] = []
    index: dict[str, int] = {}
    references = 0
    rewritten: dict[str, bytes] = {}
    for part in sheet_parts.values():
        root = etree.fromstring(parts[part])
        _fill_cached(root, values_by_part.get(part, {}), part)
        references += _share_strings(root, table, index, frozenset(keep_inline))
        rewritten[part] = _serialize(root)

    extra: dict[str, bytes] = {}
    if table:
        if "xl/sharedStrings.xml" in parts:
            raise ValueError("openpyxl already wrote a shared string table")
        extra["xl/sharedStrings.xml"] = _shared_strings_xml(table, references)
        types = etree.fromstring(parts["[Content_Types].xml"])
        etree.SubElement(types, f"{{{CT}}}Override", PartName="/xl/sharedStrings.xml", ContentType=SST_CT)
        rewritten["[Content_Types].xml"] = _serialize(types)
        rels = etree.fromstring(parts["xl/_rels/workbook.xml.rels"])
        etree.SubElement(rels, f"{{{PR}}}Relationship", Id="rIdSharedStrings", Type=SST_REL, Target="sharedStrings.xml")
        rewritten["xl/_rels/workbook.xml.rels"] = _serialize(rels)

    return normalize_zip(buffer.getvalue(), lambda name, data: rewritten.get(name, data), extra)
