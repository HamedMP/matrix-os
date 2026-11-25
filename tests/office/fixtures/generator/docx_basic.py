"""basic.docx, numbering.docx, table.docx and unicode.docx."""

from __future__ import annotations

from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import parse_xml
from docx.shared import Pt, RGBColor

from .ooxml import NSDECL, add_char_style, add_para_style, append_xml, docx_bytes, new_document, para, run


def basic() -> bytes:
    doc = new_document("Basic formatting sample")

    def note_style(style):
        style.font.italic = True
        style.font.size = Pt(10)
        style.font.color.rgb = RGBColor(0x44, 0x55, 0x66)
        style.paragraph_format.left_indent = Pt(18)

    add_para_style(doc, "Callout Note", setup=note_style)
    add_char_style(doc, "Key Term", lambda font: (setattr(font, "bold", True), setattr(font, "small_caps", True)))

    doc.add_heading("Quarterly Operations Review", level=0)
    doc.add_heading("Summary", level=1)
    p = doc.add_paragraph("This review covers the ")
    p.add_run("third quarter").bold = True
    p.add_run(" and highlights ")
    p.add_run("three").italic = True
    p.add_run(" priorities that need ")
    u = p.add_run("owner approval")
    u.underline = True
    p.add_run(".")

    p = doc.add_paragraph()
    r = p.add_run("Bold italic underlined")
    r.bold = r.italic = r.underline = True
    p.add_run(" text sits next to ")
    p.add_run("a Key Term", style="Key Term")
    p.add_run(" styled with a character style.")

    doc.add_heading("Details", level=1)
    doc.add_heading("Revenue", level=2)
    doc.add_paragraph("Revenue grew steadily across every region, with the strongest growth in the north.")
    doc.add_paragraph("Figures are unaudited and may change after the year-end review.", style="Callout Note")
    doc.add_heading("Costs", level=2)
    p = doc.add_paragraph("Operating costs stayed flat. ")
    p.add_run("Hiring was paused").bold = True
    p.add_run(" for two months.")
    centred = doc.add_paragraph("Centred closing line.")
    centred.alignment = WD_ALIGN_PARAGRAPH.CENTER
    doc.add_paragraph("A quotation to finish the review.", style="Quote")
    return docx_bytes(doc)


def _lvl(ilvl: int, fmt: str, text: str, indent: int, font: str | None = None) -> str:
    rpr = f'<w:rPr><w:rFonts w:ascii="{font}" w:hAnsi="{font}"/></w:rPr>' if font else ""
    return (
        f'<w:lvl w:ilvl="{ilvl}"><w:start w:val="1"/><w:numFmt w:val="{fmt}"/>'
        f'<w:lvlText w:val="{text}"/><w:lvlJc w:val="left"/>'
        f'<w:pPr><w:ind w:left="{indent}" w:hanging="360"/></w:pPr>{rpr}</w:lvl>'
    )


NUMBERING_XML = (
    f"<w:numbering {NSDECL}>"
    '<w:abstractNum w:abstractNumId="10"><w:multiLevelType w:val="multilevel"/>'
    + _lvl(0, "decimal", "%1.", 360)
    + _lvl(1, "decimal", "%1.%2.", 792)
    + _lvl(2, "lowerLetter", "(%3)", 1224)
    + "</w:abstractNum>"
    '<w:abstractNum w:abstractNumId="11"><w:multiLevelType w:val="hybridMultilevel"/>'
    + _lvl(0, "bullet", "•", 720)
    + _lvl(1, "bullet", "–", 1440)
    + "</w:abstractNum>"
    '<w:num w:numId="1"><w:abstractNumId w:val="10"/></w:num>'
    '<w:num w:numId="2"><w:abstractNumId w:val="11"/></w:num>'
    '<w:num w:numId="3"><w:abstractNumId w:val="10"/>'
    '<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>'
    "</w:numbering>"
)


def numbering() -> bytes:
    doc = new_document("Numbering sample")
    doc.part.numbering_part._element = parse_xml(NUMBERING_XML)

    def item(text: str, num_id: int, ilvl: int) -> None:
        ppr = f'<w:numPr><w:ilvl w:val="{ilvl}"/><w:numId w:val="{num_id}"/></w:numPr>'
        append_xml(doc, para(run(text), ppr, style="ListParagraph"))

    doc.add_heading("Numbered and bulleted lists", level=1)
    doc.add_paragraph("Multi-level list (1 / 1.1 / (a)):")
    item("Scope of work", 1, 0)
    item("Discovery workshops", 1, 1)
    item("Stakeholder interviews", 1, 2)
    item("Current-state process maps", 1, 2)
    item("Implementation", 1, 1)
    item("Acceptance", 1, 0)
    item("Acceptance criteria", 1, 1)
    item("Sign-off by the owner", 1, 2)
    doc.add_paragraph("Bulleted list:")
    item("Coffee", 2, 0)
    item("Tea", 2, 0)
    item("Green tea", 2, 1)
    item("Water", 2, 0)
    doc.add_paragraph("A second numbered list that restarts at 1:")
    item("Collect feedback", 3, 0)
    item("Group feedback by theme", 3, 1)
    item("Publish the summary", 3, 0)
    return docx_bytes(doc)


def table() -> bytes:
    doc = new_document("Table sample")

    def cell_style(style):
        style.font.size = Pt(9)
        style.font.bold = True
        style.font.color.rgb = RGBColor(0x1F, 0x3A, 0x5F)

    add_para_style(doc, "Table Label", setup=cell_style)
    doc.add_heading("Project budget", level=1)
    doc.add_paragraph("The table below has a merged title row, a vertically merged cell and styled labels.")
    grid = doc.add_table(rows=5, cols=4)
    grid.style = doc.styles["Table Grid"]
    title = grid.cell(0, 0).merge(grid.cell(0, 3))
    title.text = "Budget by phase (EUR)"
    headers = ["Phase", "Owner", "Q1", "Q2"]
    for col, text in enumerate(headers):
        cell = grid.cell(1, col)
        cell.text = ""
        cell.paragraphs[0].add_run(text)
        cell.paragraphs[0].style = doc.styles["Table Label"]
    rows = [("Design", "Ana", "12,000", "8,500"), ("Build", "Ana", "30,000", "42,000"), ("Launch", "Ben", "5,000", "9,250")]
    for r, values in enumerate(rows, start=2):
        for c, value in enumerate(values):
            grid.cell(r, c).text = value
    owner = grid.cell(2, 1).merge(grid.cell(3, 1))
    owner.text = "Ana"
    note = grid.cell(4, 3).add_paragraph("Includes launch event.")
    note.style = doc.styles["Table Label"]
    doc.add_paragraph("Totals are calculated outside this document.")
    return docx_bytes(doc)


def unicode_doc() -> bytes:
    doc = new_document("Unicode and whitespace sample")
    doc.add_heading("Unicode, whitespace and right-to-left text", level=1)
    rtl = '<w:bidi/><w:jc w:val="right"/>'
    append_xml(doc, para(run("שלום עולם, זהו מסמך לדוגמה.", "<w:rtl/>"), rtl))
    append_xml(doc, para(run("مرحبا بالعالم، هذا مستند تجريبي.", '<w:rtl/><w:lang w:bidi="ar-SA"/>'), rtl))
    append_xml(doc, para(run("Launch \U0001F680 done ✅, developer \U0001F469‍\U0001F4BB, flag \U0001F1EA\U0001F1FA.")))
    append_xml(doc, para(run("Price: 10 000 EUR (non-breaking spaces).")))
    append_xml(doc, para(run(inner='<w:t>Name</w:t><w:tab/><w:t>Value</w:t><w:tab/><w:t>Notes</w:t>')))
    append_xml(doc, para(run(inner='<w:t>First line</w:t><w:br/><w:t>second line after a soft break</w:t>')))
    append_xml(doc, para(run("  two leading spaces and two trailing  ")
                         + run(" spaced ", "<w:b/>")
                         + run("double  inner  spaces")))
    append_xml(doc, para(run("Mat") + run("rix", "<w:i/>") + run(" split across runs; café vs café; 文档; <&> \"quotes\"")))
    append_xml(doc, para(run(inner='<w:t>well</w:t><w:noBreakHyphen/><w:t>known and soft</w:t><w:softHyphen/><w:t>hyphen</w:t>')))
    doc.add_paragraph("Ends with a trailing tab\t")
    return docx_bytes(doc)
