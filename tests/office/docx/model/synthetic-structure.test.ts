import { describe, expect, it } from "vitest";

import type { ParagraphBlock, SectionBreakBlock, TableBlock } from "../../../../packages/office/src/api/docx.js";
import { openDocx } from "../../../../packages/office/src/docx/index.js";
import { getDocxIndex } from "../../../../packages/office/src/docx/internal.js";
import { isOfficeError } from "../../../../packages/office/src/errors.js";
import { createElement, insertBefore } from "../../../../packages/office/src/xml/index.js";
import { buildAndReopen, buildDocument, buildPackage, cell, p, r, row, tbl } from "./build.js";

const texts = (blocks: Array<{ type: string }>): string[] =>
  blocks.filter((block): block is ParagraphBlock => block.type === "paragraph").map((block) => block.text);

describe("block ids", () => {
  it("takes ids from w14:paraId where it is unique and survives a reopen after an insertion", async () => {
    const body =
      `<w:p w14:paraId="0A0A0A01">${r("one")}</w:p><w:p w14:paraId="0A0A0A02">${r("two")}</w:p>` +
      `<w:p w14:paraId="0A0A0A02">${r("duplicate id")}</w:p>${p(r("no id"))}`;
    const document = await buildAndReopen({ body });
    const ids = document.getView().body.blocks.map((block) => block.id);
    expect(ids).toEqual(["p_0A0A0A01", "p_0A0A0A02", "b3", "b4"]);

    const index = getDocxIndex(document);
    const added = createElement("w:p", [], [createElement("w:r", [], [createElement("w:t", [], ["zero"])])]);
    insertBefore(index.requireBlock("p_0A0A0A01").element, added);
    index.markDirty(added);
    expect(index.blockOf(added)?.id).toBe("b5");
    const reopened = await openDocx(await document.save());
    const after = reopened.getView().body.blocks as ParagraphBlock[];
    expect(after.map((block) => [block.id, block.text]).slice(1, 3)).toEqual([
      ["p_0A0A0A01", "one"],
      ["p_0A0A0A02", "two"],
    ]);
  });

  it("looks through content controls and puts block-level bookmarks on the next paragraph", () => {
    const document = buildDocument({
      body:
        `<w:sdt><w:sdtPr><w:alias w:val="Contents"/></w:sdtPr><w:sdtContent>${p(r("inside one"))}${p(r("inside two"))}</w:sdtContent></w:sdt>` +
        `<w:bookmarkStart w:id="1" w:name="between"/><w:bookmarkEnd w:id="1"/>${p(r("after"))}`,
    });
    const view = document.getView();
    expect(texts(view.body.blocks)).toEqual(["inside one", "inside two", "after"]);
    expect((view.body.blocks[2] as ParagraphBlock).bookmarks).toEqual(["between"]);
    const index = getDocxIndex(document);
    const records = view.body.blocks.map((block) => index.requireBlock(block.id));
    expect(records.map((record) => [record.container.name, record.indexInContainer])).toEqual([
      ["w:body", 0],
      ["w:body", 1],
      ["w:body", 2],
    ]);
    expect(records[0]?.element.parent).toMatchObject({ name: "w:sdtContent" });
  });
});

describe("sections, headers and footers", () => {
  const sect = (content: string): string => `<w:sectPr>${content}</w:sectPr>`;
  const parts = {
    body:
      p(r("first section"), sect('<w:headerReference w:type="default" r:id="h1"/><w:headerReference w:type="first" r:id="h2"/><w:footerReference w:type="even" r:id="f1"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="720" w:right="1080" w:bottom="720" w:left="1080"/>')) +
      p(r("second section"), sect('<w:type w:val="continuous"/><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:cols w:num="2"/>')) +
      p(r("last section")) +
      sect('<w:headerReference w:type="default" r:id="h3"/><w:type w:val="oddPage"/>'),
    headers: { h1: p(r("default header")), h2: p(r("first page header")), h3: p(r("last header")), h4: p(r("orphan header")) },
    footers: { f1: p(r("even footer")) },
  };

  it("emits a break block where a section ends and describes every section", () => {
    const view = buildDocument(parts).getView();
    expect(view.body.blocks.map((block) => block.type)).toEqual(["paragraph", "sectionBreak", "paragraph", "sectionBreak", "paragraph"]);
    const breaks = view.body.blocks.filter((block): block is SectionBreakBlock => block.type === "sectionBreak");
    // A break starts the next section the way that section's own type says.
    expect(breaks.map((block) => [block.sectionIndex, block.breakType])).toEqual([
      [0, "continuous"],
      [1, "oddPage"],
    ]);
    expect(view.sections.map((s) => [s.index, s.orientation, s.columns, s.pageWidthPt, s.marginLeftPt])).toEqual([
      [0, "portrait", 1, 595.3, 54],
      [1, "landscape", 2, 841.9, 72],
      [2, "portrait", 1, 612, 72],
    ]);
  });

  it("orders header stories by reference, labels them by type and inherits them across sections", () => {
    const view = buildDocument(parts).getView();
    expect(view.headers.map((story) => [story.label, texts(story.blocks)[0]])).toEqual([
      ["Header", "default header"],
      ["Header (first page)", "first page header"],
      ["Header", "last header"],
      ["Header", "orphan header"],
    ]);
    expect(view.footers.map((story) => story.label)).toEqual(["Footer (even pages)"]);
    const [first, second, third] = view.sections;
    expect(first?.headers).toEqual({ default: view.headers[0]?.id, first: view.headers[1]?.id });
    expect(second?.headers).toEqual(first?.headers);
    expect(third?.headers).toEqual({ default: view.headers[2]?.id, first: view.headers[1]?.id });
    expect(third?.footers).toEqual({ even: view.footers[0]?.id });
  });

  it("describes a document with no section properties as one default section", () => {
    const view = buildDocument({ body: p(r("only")) }).getView();
    expect(view.sections).toHaveLength(1);
    expect(view.sections[0]).toMatchObject({ pageWidthPt: 612, pageHeightPt: 792, columns: 1, headers: {}, footers: {} });
  });
});

describe("notes", () => {
  it("orders endnotes by reference, labels them in roman numerals and appends unreferenced notes", () => {
    const note = (id: string, text: string): string => `<w:endnote w:id="${id}">${p(`<w:r><w:endnoteRef/></w:r>${r(text)}`)}</w:endnote>`;
    const reference = (id: string): string => `<w:r><w:endnoteReference w:id="${id}"/></w:r>`;
    const document = buildDocument({
      body: p(r("a") + reference("7") + r("b") + reference("3") + reference("99")),
      endnotes: `<w:endnote w:type="separator" w:id="0">${p("<w:r><w:separator/></w:r>")}</w:endnote>${note("3", "third")}${note("5", "orphan")}${note("7", "seventh")}`,
    });
    const view = document.getView();
    expect(view.endnotes.map((story) => [story.id, story.label, document.getPlainText({ storyId: story.id })])).toEqual([
      ["endnote:7", "Endnote i", "seventh\n"],
      ["endnote:3", "Endnote ii", "third\n"],
      ["endnote:5", "Endnote iii", "orphan\n"],
    ]);
    const runs = (view.body.blocks[0] as ParagraphBlock).runs;
    expect(runs.map((run) => run.footnoteRef?.label ?? null)).toEqual([null, "i", null, "ii", null]);
    // A reference to a note that does not exist is still an object, without a target.
    expect(runs[4]).toMatchObject({ text: "￼", object: { kind: "noteReference" }, footnoteRef: null });
  });
});

describe("tables", () => {
  it("reads header rows, fills, grid offsets and nested tables", () => {
    const inner = tbl(row(cell(p(r("inner")))));
    const document = buildDocument({
      body: tbl(
        row(cell(p(r("H1")), '<w:shd w:val="clear" w:fill="D9E2F3"/>') + cell(p(r("H2"))), "<w:tblHeader/>") +
          row(cell(p(r("offset"))), '<w:gridBefore w:val="1"/>') +
          row(cell(`${inner}${p("")}`) + cell(p(r("x")), '<w:tcW w:w="50" w:type="pct"/>')),
        '<w:gridCol w:w="1440"/><w:gridCol w:w="2880"/>',
      ),
    });
    const table = document.getView().body.blocks[0] as TableBlock;
    expect(table.columnWidthsPt).toEqual([72, 144]);
    expect(table.rows.map((entry) => entry.isHeader)).toEqual([true, false, false]);
    expect(table.rows[0]?.cells[0]?.fill).toBe("#d9e2f3");
    expect(table.rows[2]?.cells[1]?.widthPt).toBeNull();
    const nested = table.rows[2]?.cells[0]?.blocks[0] as TableBlock;
    expect(nested.type).toBe("table");
    expect((nested.rows[0]?.cells[0]?.blocks[0] as ParagraphBlock).text).toBe("inner");
    const index = getDocxIndex(document);
    const innerParagraph = index.requireBlock(nested.rows[0]!.cells[0]!.blocks[0]!.id);
    expect(innerParagraph).toMatchObject({ parentTableId: nested.id, topLevelId: table.id });
    expect(document.getPlainText()).toBe("H1\tH2\noffset\ninner\n\tx\n");
  });
});

describe("numbering through styles", () => {
  const level = (ilvl: number, text: string, style: string): string =>
    `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:pStyle w:val="${style}"/><w:lvlText w:val="${text}"/><w:pPr><w:ind w:left="${(ilvl + 1) * 400}" w:hanging="400"/></w:pPr></w:lvl>`;
  const parts = {
    styles:
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:numId w:val="5"/></w:numPr><w:outlineLvl w:val="0"/></w:pPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Heading1"/><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="5"/></w:numPr><w:outlineLvl w:val="1"/><w:ind w:left="1000"/></w:pPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Plain"><w:name w:val="Plain"/><w:basedOn w:val="Heading1"/><w:pPr><w:numPr><w:numId w:val="0"/></w:numPr><w:outlineLvl w:val="9"/></w:pPr></w:style>',
    numbering:
      `<w:abstractNum w:abstractNumId="1">${level(0, "%1", "Heading1")}${level(1, "%1.%2", "Heading2")}<w:lvl w:ilvl="2"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="(%3)"/></w:lvl></w:abstractNum>` +
      '<w:num w:numId="5"><w:abstractNumId w:val="1"/></w:num>',
    body:
      p(r("Scope"), '<w:pStyle w:val="Heading1"/>') +
      p(r("Background"), '<w:pStyle w:val="Heading2"/>') +
      p(r("Not numbered"), '<w:pStyle w:val="Plain"/>') +
      p(r("Terms"), '<w:pStyle w:val="Heading1"/>') +
      p(r("Payment"), '<w:pStyle w:val="Heading2"/>') +
      p(r("on delivery"), '<w:numPr><w:ilvl w:val="2"/><w:numId w:val="5"/></w:numPr>') +
      p(r("See Section 2.1, section 2.1(a), clause 1 and Section 9.")),
  };

  it("numbers headings from their style and indents them from the level unless the style says otherwise", () => {
    const view = buildDocument(parts).getView();
    const blocks = view.body.blocks as ParagraphBlock[];
    expect(blocks.map((block) => [block.text, block.numbering?.text ?? null, block.style.headingLevel])).toEqual([
      ["Scope", "1", 1],
      ["Background", "1.1", 2],
      ["Not numbered", null, 0],
      ["Terms", "2", 1],
      ["Payment", "2.1", 2],
      ["on delivery", "(a)", 0],
      ["See Section 2.1, section 2.1(a), clause 1 and Section 9.", null, 0],
    ]);
    expect(blocks[0]?.style).toMatchObject({ indentLeftPt: 20, firstLineIndentPt: -20 });
    // The style's own indent wins over the level it brings in.
    expect(blocks[1]?.style).toMatchObject({ indentLeftPt: 50, firstLineIndentPt: -20 });
  });

  it("puts numbering labels in the outline and resolves typed references to numbered paragraphs", () => {
    const document = buildDocument(parts);
    expect(document.getOutline().map((item) => [item.level, item.numberingLabel, item.text])).toEqual([
      [1, "1", "Scope"],
      [2, "1.1", "Background"],
      [1, "2", "Terms"],
      [2, "2.1", "Payment"],
    ]);
    const blocks = document.getView().body.blocks as ParagraphBlock[];
    expect(document.getCrossReferences().map((reference) => [reference.text, reference.targetBlockId, reference.targetLabel, reference.broken])).toEqual([
      ["Section 2.1", blocks[4]?.id, "2.1", false],
      ["section 2.1(a)", blocks[5]?.id, "(a)", false],
      ["clause 1", blocks[0]?.id, "1", false],
      ["Section 9", null, null, true],
    ]);
  });
});

describe("documents that cannot be opened", () => {
  const rejects = async (parts: Parameters<typeof buildPackage>[0], code: Parameters<typeof isOfficeError>[1]): Promise<void> => {
    const bytes = await buildPackage(parts).pkg.save();
    await expect(openDocx(bytes)).rejects.toSatisfy((error) => isOfficeError(error, code));
  };

  it("reports a main part without a body as a corrupt package", async () => {
    await rejects({ body: "", rawDocument: '<w:document xmlns:w="urn:x"/>' }, "corrupt_package");
    await rejects({ body: "", rawDocument: '<workbook xmlns="urn:x"/>' }, "corrupt_package");
  });

  it("reports malformed XML in the main part or in a part the model parses", async () => {
    await rejects({ body: "", rawDocument: "<w:document><w:body></w:document>" }, "malformed_xml");
    await rejects({ body: p(r("fine")), styles: "<w:style></w:styles>" }, "malformed_xml");
    await rejects({ body: "", rawDocument: '<!DOCTYPE x [<!ENTITY a "b">]><w:document xmlns:w="urn:x"><w:body/></w:document>' }, "malformed_xml");
  });

  it("reports a main part of another kind as an unsupported format", async () => {
    await rejects({ body: p(r("x")), mainContentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml" }, "unsupported_format");
  });

  it("opens a document with no styles, numbering or settings part", () => {
    const document = buildDocument({ body: p(r("bare"), '<w:pStyle w:val="Missing"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="4"/></w:numPr>') });
    const block = document.getView().body.blocks[0] as ParagraphBlock;
    expect(block.style).toMatchObject({ styleId: null, styleName: null, headingLevel: 0, alignment: "left", lineSpacing: 1 });
    expect(block.numbering).toBeNull();
    expect(block.runs[0]).toMatchObject({ bold: false, fontSizePt: null, fontFamily: null, color: null });
    expect(document.getProperties()).toEqual({ title: null, creator: null, lastModifiedBy: null, created: null, modified: null });
    expect(document.getTrackRevisions()).toBe(false);
  });
});
