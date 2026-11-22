"""contract.docx and contract-v2.docx: a three-page services agreement and a revised copy."""

from __future__ import annotations

from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Cm, Pt

from .contract_text import V2_EDITS, version
from .ooxml import docx_bytes, new_document


def plain_text(blocks) -> str:
    """The text a reader sees, one line per paragraph (used for expected/ files)."""
    lines = []
    for _, kind, number, text in blocks:
        if kind == "definition":
            lines.append(f"“{number}” {text}")
        elif kind == "signature":
            lines.extend(text.split("\t"))
        elif number:
            lines.append(f"{number}\t{text}" if kind != "heading" else f"{number} {text}")
        else:
            lines.append(text)
    return "\n".join(lines)


def _render(blocks, title: str) -> bytes:
    doc = new_document(title)
    section = doc.sections[0]
    section.page_width, section.page_height = Cm(21), Cm(29.7)
    for margin in ("left_margin", "right_margin", "top_margin", "bottom_margin"):
        setattr(section, margin, Cm(2.5))
    normal = doc.styles["Normal"]
    normal.font.name = "Calibri"
    normal.font.size = Pt(11)
    normal.paragraph_format.space_after = Pt(6)
    section.footer.paragraphs[0].text = "Services Agreement – Harbourline Analytics Ltd and Kestrel Data Services Ltd"

    for _, kind, number, text in blocks:
        if kind == "title":
            p = doc.add_heading(text, level=0)
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        elif kind == "heading":
            doc.add_heading(f"{number} {text}" if number else text, level=1)
        elif kind == "clause":
            p = doc.add_paragraph(f"{number}\t{text}")
            p.paragraph_format.left_indent = Cm(1.25)
            p.paragraph_format.first_line_indent = Cm(-1.25)
        elif kind == "sub":
            p = doc.add_paragraph(f"{number}\t{text}")
            p.paragraph_format.left_indent = Cm(2.25)
            p.paragraph_format.first_line_indent = Cm(-1.0)
        elif kind == "definition":
            p = doc.add_paragraph()
            p.paragraph_format.left_indent = Cm(1.25)
            p.add_run(f"“{number}”").bold = True
            p.add_run(f" {text}")
        elif kind == "signature":
            p = doc.add_paragraph()
            p.paragraph_format.space_before = Pt(18)
            parts = text.split("\t")
            for index, part in enumerate(parts):
                r = p.add_run(part)
                if index < len(parts) - 1:
                    r.add_break()
        else:
            doc.add_paragraph(text)
    return docx_bytes(doc)


def contract() -> bytes:
    return _render(version(), "Services Agreement")


def contract_v2() -> bytes:
    return _render(version(V2_EDITS), "Services Agreement (revised)")


def contract_texts() -> tuple[str, str]:
    return plain_text(version()), plain_text(version(V2_EDITS))
