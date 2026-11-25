"""Helpers shared by the fixture generators: raw WordprocessingML snippets, extra parts,
and deterministic ZIP output."""

from __future__ import annotations

import datetime as dt
import io
import re
import zipfile
from xml.sax.saxutils import escape

from docx.opc.packuri import PackURI
from docx.opc.part import Part
from docx.oxml import parse_xml
from lxml import etree

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
W14_NS = "http://schemas.microsoft.com/office/word/2010/wordml"
W15_NS = "http://schemas.microsoft.com/office/word/2012/wordml"
MC_NS = "http://schemas.openxmlformats.org/markup-compatibility/2006"
NSDECL = f'xmlns:w="{W_NS}" xmlns:r="{R_NS}" xmlns:w14="{W14_NS}" xmlns:w15="{W15_NS}" xmlns:mc="{MC_NS}"'

RT_BASE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
CT_WML = "application/vnd.openxmlformats-officedocument.wordprocessingml"

FIXED_DATE = dt.datetime(2026, 1, 1, 0, 0, 0)
FIXED_ISO = "2026-01-01T00:00:00Z"
ZIP_TIME = (1980, 1, 1, 0, 0, 0)


def t(text: str) -> str:
    """A <w:t> element, preserving spaces when needed."""
    space = ' xml:space="preserve"' if text != text.strip() or "  " in text else ""
    return f"<w:t{space}>{escape(text)}</w:t>"


def run(text: str = "", rpr: str = "", inner: str | None = None) -> str:
    body = inner if inner is not None else t(text)
    props = f"<w:rPr>{rpr}</w:rPr>" if rpr else ""
    return f"<w:r>{props}{body}</w:r>"


def del_run(text: str, rpr: str = "") -> str:
    space = ' xml:space="preserve"' if text != text.strip() else ""
    return run(rpr=rpr, inner=f"<w:delText{space}>{escape(text)}</w:delText>")


def para(content: str, ppr: str = "", style: str | None = None) -> str:
    style_xml = f'<w:pStyle w:val="{style}"/>' if style else ""
    props = f"<w:pPr>{style_xml}{ppr}</w:pPr>" if (style_xml or ppr) else ""
    return f"<w:p {NSDECL}>{props}{content}</w:p>"


def field(instruction: str, result: str, rpr: str = "") -> str:
    """A complex field: begin, instruction, separate, cached result, end."""
    props = f"<w:rPr>{rpr}</w:rPr>" if rpr else ""
    return (
        f'<w:r>{props}<w:fldChar w:fldCharType="begin"/></w:r>'
        f'<w:r>{props}<w:instrText xml:space="preserve"> {escape(instruction)} </w:instrText></w:r>'
        f'<w:r>{props}<w:fldChar w:fldCharType="separate"/></w:r>'
        f"{run(result, rpr)}"
        f'<w:r>{props}<w:fldChar w:fldCharType="end"/></w:r>'
    )


def append_xml(doc, xml: str):
    """Append a block-level element before the final section properties."""
    body = doc.element.body
    element = parse_xml(xml)
    etree.cleanup_namespaces(element)
    sect = body.find(f"{{{W_NS}}}sectPr")
    if sect is not None:
        sect.addprevious(element)
    else:
        body.append(element)
    return element


def add_part(doc, partname: str, content_type: str, reltype: str, xml: str) -> str:
    part = Part(PackURI(partname), content_type, xml.encode("utf-8"), doc.part.package)
    return doc.part.relate_to(part, reltype)


def add_char_style(doc, name: str, rpr_setup=None):
    from docx.enum.style import WD_STYLE_TYPE

    style = doc.styles.add_style(name, WD_STYLE_TYPE.CHARACTER)
    if rpr_setup:
        rpr_setup(style.font)
    return style


def add_para_style(doc, name: str, base: str = "Normal", setup=None):
    from docx.enum.style import WD_STYLE_TYPE

    style = doc.styles.add_style(name, WD_STYLE_TYPE.PARAGRAPH)
    style.base_style = doc.styles[base]
    if setup:
        setup(style)
    return style


def new_document(title: str):
    from docx import Document

    doc = Document()
    props = doc.core_properties
    props.title = title
    props.author = "Matrix OS fixtures"
    props.last_modified_by = "Matrix OS fixtures"
    props.created = FIXED_DATE
    props.modified = FIXED_DATE
    props.last_printed = FIXED_DATE
    props.revision = 1
    props.comments = ""
    props.keywords = "matrix-os office fixture"
    return doc


def docx_bytes(doc) -> bytes:
    buffer = io.BytesIO()
    doc.save(buffer)
    return normalize_zip(buffer.getvalue())


_CORE_DATE = re.compile(rb"(<dcterms:(?:created|modified)[^>]*>)[^<]*(</dcterms:)")


def normalize_zip(data: bytes, transform=None, extra: dict[str, bytes] | None = None) -> bytes:
    """Rewrite a ZIP with fixed timestamps and attributes so output is byte-stable.

    ``transform(name, data) -> data`` may rewrite individual parts; ``extra`` adds parts.
    """
    source = zipfile.ZipFile(io.BytesIO(data))
    out = io.BytesIO()
    entries = [(info.filename, source.read(info)) for info in source.infolist()]
    entries += sorted((extra or {}).items())
    with zipfile.ZipFile(out, "w") as target:
        for filename, payload in entries:
            if filename == "docProps/core.xml":
                payload = _CORE_DATE.sub(rb"\g<1>" + FIXED_ISO.encode() + rb"\g<2>", payload)
            if transform is not None:
                payload = transform(filename, payload)
            entry = zipfile.ZipInfo(filename, date_time=ZIP_TIME)
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o644 << 16
            entry.create_system = 0
            target.writestr(entry, payload, compresslevel=9)
    return out.getvalue()
