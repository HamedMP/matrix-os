"""comments.docx, footnotes-headers.docx, tracked.docx and links-fields.docx."""

from __future__ import annotations

from docx.enum.style import WD_STYLE_TYPE
from lxml import etree
from docx.shared import Pt, RGBColor

from .ooxml import (CT_WML, NSDECL, RT_BASE, add_part, append_xml, del_run, docx_bytes, field,
                    new_document, para, run, t)

ALEX = 'w:author="Alex Morgan" w:date="2026-01-05T09:30:00Z"'
PRIYA = 'w:author="Priya Shah" w:date="2026-01-06T14:15:00Z"'


def _ensure_styles(doc) -> None:
    styles = doc.styles
    if "Footnote Text" not in [s.name for s in styles]:
        text = styles.add_style("Footnote Text", WD_STYLE_TYPE.PARAGRAPH)
        text.base_style = styles["Normal"]
        text.font.size = Pt(9)
        ref = styles.add_style("Footnote Reference", WD_STYLE_TYPE.CHARACTER)
        ref.font.superscript = True
        link = styles.add_style("Hyperlink", WD_STYLE_TYPE.CHARACTER)
        link.font.color.rgb = RGBColor(0x05, 0x63, 0xC1)
        link.font.underline = True
        comment = styles.add_style("Comment Text", WD_STYLE_TYPE.PARAGRAPH)
        comment.base_style = styles["Normal"]
        comment.font.size = Pt(10)
        styles.add_style("Comment Reference", WD_STYLE_TYPE.CHARACTER).font.size = Pt(8)
        for level in (1, 2):
            toc = styles.add_style(f"TOC {level}", WD_STYLE_TYPE.PARAGRAPH)
            toc.base_style = styles["Normal"]
            toc.paragraph_format.left_indent = Pt(12 * (level - 1))


def _comment(comment_id: int, author: str, initials: str, date: str, para_id: str, text: str) -> str:
    return (
        f'<w:comment w:id="{comment_id}" w:author="{author}" w:date="{date}" w:initials="{initials}">'
        f'<w:p w14:paraId="{para_id}" w14:textId="77777777"><w:pPr><w:pStyle w:val="CommentText"/></w:pPr>'
        '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:annotationRef/></w:r>'
        f"{run(text)}</w:p></w:comment>"
    )


def comments() -> bytes:
    doc = new_document("Comments sample")
    _ensure_styles(doc)
    doc.add_heading("Proposal for the new office", level=1)
    ref = '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="{0}"/></w:r>'
    append_xml(doc, para(
        run("We propose moving to ")
        + '<w:commentRangeStart w:id="0"/><w:commentRangeStart w:id="2"/>'
        + run("the riverside building")
        + '<w:commentRangeEnd w:id="0"/>' + ref.format(0)
        + '<w:commentRangeEnd w:id="2"/>' + ref.format(2)
        + run(" by the end of the year.")
    ))
    append_xml(doc, para(
        run("The expected annual rent is ")
        + '<w:commentRangeStart w:id="1"/>' + run("EUR 240,000") + '<w:commentRangeEnd w:id="1"/>'
        + ref.format(1) + run(", including service charges.")
    ))
    doc.add_paragraph("A decision is needed at the next board meeting.")
    comments_xml = (
        f"<w:comments {NSDECL}>"
        + _comment(0, "Alex Morgan", "AM", "2026-01-05T09:30:00Z", "1A2B3C01", "Is parking included in this building?")
        + _comment(1, "Priya Shah", "PS", "2026-01-06T14:15:00Z", "1A2B3C02", "Please confirm whether this figure includes VAT.")
        + _comment(2, "Priya Shah", "PS", "2026-01-06T14:20:00Z", "1A2B3C03", "Yes, 40 spaces are included.")
        + "</w:comments>"
    )
    extended_xml = (
        f'<w15:commentsEx {NSDECL} mc:Ignorable="w14 w15">'
        '<w15:commentEx w15:paraId="1A2B3C01" w15:done="0"/>'
        '<w15:commentEx w15:paraId="1A2B3C02" w15:done="0"/>'
        '<w15:commentEx w15:paraId="1A2B3C03" w15:paraIdParent="1A2B3C01" w15:done="0"/>'
        "</w15:commentsEx>"
    )
    add_part(doc, "/word/comments.xml", f"{CT_WML}.comments+xml", f"{RT_BASE}/comments", comments_xml)
    add_part(doc, "/word/commentsExtended.xml", f"{CT_WML}.commentsExtended+xml",
             "http://schemas.microsoft.com/office/2011/relationships/commentsExtended", extended_xml)
    return docx_bytes(doc)


def _footnote(note_id: int, text: str) -> str:
    return (
        f'<w:footnote w:id="{note_id}"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr>'
        '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r>'
        f"{run(' ' + text)}</w:p></w:footnote>"
    )


def footnotes_headers() -> bytes:
    doc = new_document("Footnotes and headers sample")
    _ensure_styles(doc)
    section = doc.sections[0]
    section.header.paragraphs[0].text = "Matrix OS fixture – Confidential"
    footer = section.footer.paragraphs[0]
    footer_xml = run("Page ") + field("PAGE", "1") + run(" of ") + \
        f'<w:fldSimple w:instr=" NUMPAGES "><w:r>{t("1")}</w:r></w:fldSimple>'
    _append_children(footer._p, footer_xml)
    ref = '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="{0}"/></w:r>'
    doc.add_heading("Research summary", level=1)
    append_xml(doc, para(run("Remote work increased output in most teams") + ref.format(1)
                         + run(" although results varied by role.") + ref.format(2)))
    append_xml(doc, para(run("A follow-up survey is planned for the spring") + ref.format(3) + run(".")))
    doc.add_paragraph("The header and footer repeat on every page; the footer shows the page number.")
    footnotes_xml = (
        f"<w:footnotes {NSDECL}>"
        '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>'
        '<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>'
        + _footnote(1, "Internal productivity study, 2025.")
        + _footnote(2, "Engineering roles showed the largest change.")
        + _footnote(3, "Subject to budget approval.")
        + "</w:footnotes>"
    )
    add_part(doc, "/word/footnotes.xml", f"{CT_WML}.footnotes+xml", f"{RT_BASE}/footnotes", footnotes_xml)
    return docx_bytes(doc)


def _append_children(target, xml: str) -> None:
    """Parse sibling runs and append each to an existing paragraph element."""
    from docx.oxml import parse_xml

    holder = parse_xml(f"<w:p {NSDECL}>{xml}</w:p>")
    etree.cleanup_namespaces(holder)
    for child in list(holder):
        target.append(child)


def tracked() -> bytes:
    doc = new_document("Tracked changes sample")
    doc.add_heading("Tracked Changes Sample", level=1)
    append_xml(doc, para(
        run("The supplier shall deliver the ")
        + f'<w:ins w:id="101" {ALEX}>{run("revised ")}</w:ins>'
        + run("report within ")
        + f'<w:del w:id="102" {PRIYA}>{del_run("ten")}</w:del>'
        + f'<w:ins w:id="103" {PRIYA}>{run("fifteen")}</w:ins>'
        + run(" business days.")
    ))
    append_xml(doc, para(
        run("Payment terms are ")
        + run("net thirty days", f'<w:b/><w:rPrChange w:id="104" {ALEX}><w:rPr/></w:rPrChange>')
        + run(".")
    ))
    append_xml(doc, para(
        f'<w:moveFromRangeStart w:id="105" w:name="move1" {PRIYA}/>'
        f'<w:moveFrom w:id="106" {PRIYA}>{run("This paragraph will be moved to the end.")}</w:moveFrom>'
        '<w:moveFromRangeEnd w:id="105"/>',
        ppr=f'<w:rPr><w:moveFrom w:id="107" {PRIYA}/></w:rPr>',
    ))
    append_xml(doc, para(
        run("Fees are fixed for the initial term.")
        + f'<w:ins w:id="108" {ALEX}>{run(" Thereafter fees may rise by up to ")}</w:ins>'
        + f'<w:ins w:id="109" {ALEX}><w:del w:id="110" {PRIYA}>{del_run("five")}</w:del></w:ins>'
        + f'<w:ins w:id="111" {PRIYA}>{run("three")}</w:ins>'
        + f'<w:ins w:id="112" {ALEX}>{run(" percent.")}</w:ins>'
    ))
    append_xml(doc, para(
        f'<w:del w:id="113" {ALEX}>{del_run("This obsolete sentence is removed.")}</w:del>',
        ppr=f'<w:rPr><w:del w:id="114" {ALEX}/></w:rPr>',
    ))
    append_xml(doc, para(
        f'<w:ins w:id="115" {PRIYA}>{run("A new confidentiality obligation applies.")}</w:ins>',
        ppr=f'<w:rPr><w:ins w:id="116" {PRIYA}/></w:rPr>',
    ))
    append_xml(doc, para(
        run("Governing law: England and Wales."),
        ppr=f'<w:jc w:val="center"/><w:pPrChange w:id="117" {ALEX}><w:pPr><w:jc w:val="left"/></w:pPr></w:pPrChange>',
    ))
    cell = '<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr><w:p>{0}</w:p></w:tc>'
    append_xml(doc, (
        f'<w:tbl {NSDECL}><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr>'
        '<w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/></w:tblGrid>'
        f'<w:tr>{cell.format(run("Item"))}{cell.format(run("Qty"))}</w:tr>'
        f'<w:tr><w:trPr><w:ins w:id="118" {ALEX}/></w:trPr>'
        + cell.format(f'<w:ins w:id="119" {ALEX}>{run("Widgets")}</w:ins>')
        + cell.format(f'<w:ins w:id="120" {ALEX}>{run("10")}</w:ins>')
        + "</w:tr></w:tbl>"
    ))
    append_xml(doc, para(
        f'<w:moveToRangeStart w:id="121" w:name="move1" {PRIYA}/>'
        f'<w:moveTo w:id="122" {PRIYA}>{run("This paragraph will be moved to the end.")}</w:moveTo>'
        '<w:moveToRangeEnd w:id="121"/>',
        ppr=f'<w:rPr><w:moveTo w:id="123" {PRIYA}/></w:rPr>',
    ))
    doc.add_paragraph("End of sample.")
    return docx_bytes(doc)


def links_fields() -> bytes:
    doc = new_document("Links and fields sample")
    _ensure_styles(doc)
    link_rid = doc.part.relate_to("https://example.com/terms", f"{RT_BASE}/hyperlink", is_external=True)
    hyperlink_rpr = '<w:rStyle w:val="Hyperlink"/>'
    doc.add_heading("Contents", level=1)
    append_xml(doc, para(
        field('TOC \\o "1-3" \\h \\z \\u', "1 Introduction\t1").replace('<w:r><w:fldChar w:fldCharType="end"/></w:r>', ""),
        style="TOC1",
    ))
    append_xml(doc, para(run(inner="<w:t>2 Definitions</w:t><w:tab/><w:t>1</w:t>")
                         + '<w:r><w:fldChar w:fldCharType="end"/></w:r>', style="TOC1"))
    append_xml(doc, para(
        '<w:bookmarkStart w:id="1" w:name="_Toc1001"/>' + run("Introduction") + '<w:bookmarkEnd w:id="1"/>',
        style="Heading1",
    ))
    append_xml(doc, para(
        run("Read the full ")
        + f'<w:hyperlink r:id="{link_rid}" w:history="1">{run("terms of service", hyperlink_rpr)}</w:hyperlink>'
        + run(" before continuing, or jump to the ")
        + f'<w:hyperlink w:anchor="_Ref_Definitions" w:history="1">{run("definitions", hyperlink_rpr)}</w:hyperlink>'
        + run(".")
    ))
    append_xml(doc, para(
        run("As explained in ") + field("REF _Ref_Definitions \\h", "Definitions")
        + run(" on page ") + field("PAGEREF _Ref_Definitions \\h", "1") + run(", terms are capitalised.")
    ))
    append_xml(doc, para(
        '<w:bookmarkStart w:id="2" w:name="_Toc1002"/><w:bookmarkStart w:id="3" w:name="_Ref_Definitions"/>'
        + run("Definitions") + '<w:bookmarkEnd w:id="3"/><w:bookmarkEnd w:id="2"/>',
        style="Heading1",
    ))
    append_xml(doc, para(run("“Service”", "<w:b/>") + run(" means the hosted product.")))
    append_xml(doc, para(run("Printed on ") + f'<w:fldSimple w:instr=" DATE \\@ &quot;d MMMM yyyy&quot; "><w:r>{t("1 January 2026")}</w:r></w:fldSimple>' + run(".")))
    return docx_bytes(doc)
