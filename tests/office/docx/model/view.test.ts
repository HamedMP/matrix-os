import { describe, expect, it } from "vitest";

import type { ParagraphBlock, TableBlock } from "../../../../packages/office/src/api/docx.js";
import { openFixture, paragraphStarting, paragraphsOf, tablesOf } from "./helpers.js";

describe("view model: styles and run formatting (basic.docx)", () => {
  it("resolves heading levels and style names through the style chain", async () => {
    const view = (await openFixture("basic.docx")).getView();
    const facts = paragraphsOf(view.body).map((p) => [p.style.styleId, p.style.styleName, p.style.headingLevel]);
    expect(facts).toEqual([
      ["Title", "Title", 0],
      ["Heading1", "Heading 1", 1],
      ["Normal", "Normal", 0],
      ["Normal", "Normal", 0],
      ["Heading1", "Heading 1", 1],
      ["Heading2", "Heading 2", 2],
      ["Normal", "Normal", 0],
      ["CalloutNote", "Callout Note", 0],
      ["Heading2", "Heading 2", 2],
      ["Normal", "Normal", 0],
      ["Normal", "Normal", 0],
      ["Quote", "Quote", 0],
    ]);
  });

  it("resolves paragraph properties from defaults, styles and direct formatting", async () => {
    const view = (await openFixture("basic.docx")).getView();
    const normal = paragraphStarting(view.body, "This review covers");
    // Document defaults: 10 pt after, line 276/240.
    expect(normal.style).toMatchObject({ alignment: "left", spacingBeforePt: 0, spacingAfterPt: 10, lineSpacing: 1.15 });
    const heading = paragraphStarting(view.body, "Summary");
    expect(heading.style).toMatchObject({ spacingBeforePt: 24, spacingAfterPt: 0, keepWithNext: true });
    const callout = paragraphStarting(view.body, "Figures are unaudited");
    expect(callout.style.indentLeftPt).toBe(18);
    expect(paragraphStarting(view.body, "Centred closing line").style.alignment).toBe("center");
    // Title overrides the default line spacing with exactly single spacing.
    expect(paragraphStarting(view.body, "Quarterly Operations Review").style).toMatchObject({ spacingAfterPt: 15, lineSpacing: 1 });
  });

  it("splits runs by formatting and resolves each run through paragraph and character styles", async () => {
    const view = (await openFixture("basic.docx")).getView();
    const mixed = paragraphStarting(view.body, "This review covers");
    expect(mixed.runs.map((run) => [run.text, run.bold, run.italic, run.underline])).toEqual([
      ["This review covers the ", false, false, false],
      ["third quarter", true, false, false],
      [" and highlights ", false, false, false],
      ["three", false, true, false],
      [" priorities that need ", false, false, false],
      ["owner approval", false, false, true],
      [".", false, false, false],
    ]);
    expect(mixed.runs[0]).toMatchObject({ fontSizePt: 11, color: null, highlight: null, verticalAlign: "baseline", strike: false });
    // Theme fonts: body text uses the minor font, headings the major one.
    expect(mixed.runs[0]?.fontFamily).toBe("Cambria");
    const heading = paragraphStarting(view.body, "Summary");
    expect(heading.runs[0]).toMatchObject({ bold: true, color: "#365f91", fontSizePt: 14, fontFamily: "Calibri" });

    const styled = paragraphStarting(view.body, "Bold italic underlined");
    expect(styled.runs[0]).toMatchObject({ bold: true, italic: true, underline: true });
    const keyTerm = styled.runs.find((run) => run.text === "a Key Term");
    expect(keyTerm?.bold).toBe(true);
    const callout = paragraphStarting(view.body, "Figures are unaudited");
    expect(callout.runs[0]).toMatchObject({ italic: true, color: "#445566", fontSizePt: 10 });
    expect(paragraphStarting(view.body, "A quotation").runs[0]).toMatchObject({ italic: true, color: "#000000" });
  });

  it("describes the single section", async () => {
    const view = (await openFixture("basic.docx")).getView();
    expect(view.sections).toEqual([
      {
        index: 0,
        pageWidthPt: 612,
        pageHeightPt: 792,
        orientation: "portrait",
        marginTopPt: 72,
        marginRightPt: 90,
        marginBottomPt: 72,
        marginLeftPt: 90,
        columns: 1,
        headers: {},
        footers: {},
      },
    ]);
    expect((await openFixture("contract.docx")).getView().sections[0]).toMatchObject({
      pageWidthPt: 595.3,
      pageHeightPt: 841.9,
      orientation: "portrait",
      marginLeftPt: 70.85,
    });
  });

  it("returns single blocks and stories by id, and null for unknown ids", async () => {
    const document = await openFixture("basic.docx");
    const view = document.getView();
    for (const block of view.body.blocks) expect(document.getBlock(block.id)).toEqual(block);
    expect(document.getStory("body")).toEqual(view.body);
    expect(document.getBlock("nope")).toBeNull();
    expect(document.getStory("nope")).toBeNull();
  });
});

describe("view model: tables (table.docx)", () => {
  async function table(): Promise<TableBlock> {
    const view = (await openFixture("table.docx")).getView();
    return tablesOf(view.body)[0] as TableBlock;
  }
  const cellText = (t: TableBlock, row: number, cell: number): string[] =>
    (t.rows[row]?.cells[cell]?.blocks ?? []).map((block) => (block as ParagraphBlock).text);

  it("has the grid, the rows and the cell text", async () => {
    const t = await table();
    expect(t.columnWidthsPt).toEqual([108, 108, 108, 108]);
    expect(t.rows.map((row) => row.cells.length)).toEqual([1, 4, 4, 4, 4]);
    expect(cellText(t, 0, 0)).toEqual(["Budget by phase (EUR)"]);
    expect(t.rows[1]?.cells.map((_cell, index) => cellText(t, 1, index)[0])).toEqual(["Phase", "Owner", "Q1", "Q2"]);
    expect(cellText(t, 4, 3)).toEqual(["9,250", "Includes launch event."]);
    expect(t.rows.every((row) => row.revision === null && !row.isHeader)).toBe(true);
  });

  it("reports horizontal and vertical merges", async () => {
    const t = await table();
    expect(t.rows[0]?.cells[0]).toMatchObject({ colSpan: 4, rowSpan: 1, mergedAbove: false, widthPt: 432 });
    expect(t.rows[2]?.cells[1]).toMatchObject({ colSpan: 1, rowSpan: 2, mergedAbove: false });
    expect(t.rows[3]?.cells[1]).toMatchObject({ rowSpan: 1, mergedAbove: true });
    expect(cellText(t, 3, 1)).toEqual([""]);
    expect(t.rows[4]?.cells[1]).toMatchObject({ rowSpan: 1, mergedAbove: false });
  });

  it("resolves cell paragraphs through the table style and their own style", async () => {
    const t = await table();
    const label = t.rows[1]?.cells[0]?.blocks[0] as ParagraphBlock;
    expect(label.style).toMatchObject({ styleId: "TableLabel", styleName: "Table Label", spacingAfterPt: 0, lineSpacing: 1 });
    expect(label.runs).toHaveLength(1);
    expect(label.runs[0]).toMatchObject({ text: "Phase", bold: true, color: "#1f3a5f", fontSizePt: 9 });
    const plain = t.rows[2]?.cells[0]?.blocks[0] as ParagraphBlock;
    expect(plain.runs[0]).toMatchObject({ bold: false, fontSizePt: 11 });
  });

  it("gives nested blocks ids that resolve through getBlock, unique across the document", async () => {
    const document = await openFixture("table.docx");
    const t = tablesOf(document.getView().body)[0] as TableBlock;
    const ids = new Set<string>([t.id]);
    for (const row of t.rows) {
      for (const cell of row.cells) {
        for (const block of cell.blocks) {
          expect(ids.has(block.id)).toBe(false);
          ids.add(block.id);
          expect(document.getBlock(block.id)).toEqual(block);
        }
      }
    }
    // One table and the 18 paragraphs in its cells.
    expect(ids.size).toBe(19);
    expect(document.getPlainText()).toContain("Build\t\t30,000\t42,000\nLaunch\tBen\t5,000\t9,250\nIncludes launch event.\n");
  });
});

describe("view model: unicode.docx text is exact", () => {
  it("keeps every character, space and special inline element", async () => {
    const view = (await openFixture("unicode.docx")).getView();
    expect(paragraphsOf(view.body).map((p) => p.text)).toEqual([
      "Unicode, whitespace and right-to-left text",
      "שלום עולם, זהו מסמך לדוגמה.",
      "مرحبا بالعالم، هذا مستند تجريبي.",
      "Launch \u{1F680} done ✅, developer \u{1F469}‍\u{1F4BB}, flag \u{1F1EA}\u{1F1FA}.",
      "Price: 10 000 EUR (non-breaking spaces).",
      "Name\tValue\tNotes",
      "First line\nsecond line after a soft break",
      "  two leading spaces and two trailing   spaced double  inner  spaces",
      "Matrix split across runs; café vs café; 文档; <&> \"quotes\"",
      "well‑known and soft­hyphen",
      "Ends with a trailing tab\t",
    ]);
  });

  it("counts offsets in UTF-16 code units and merges tabs and breaks into text runs", async () => {
    const view = (await openFixture("unicode.docx")).getView();
    const emoji = paragraphStarting(view.body, "Launch");
    // 40 code points, five of them outside the basic plane.
    expect([...emoji.text]).toHaveLength(40);
    expect(emoji.text.length).toBe(45);
    expect(emoji.runs).toHaveLength(1);
    expect(paragraphStarting(view.body, "Name").runs).toHaveLength(1);
    expect(paragraphStarting(view.body, "First line").runs).toHaveLength(1);
    const spaced = paragraphStarting(view.body, "  two leading");
    expect(spaced.runs.map((run) => [run.start, run.text, run.bold])).toEqual([
      [0, "  two leading spaces and two trailing  ", false],
      [39, " spaced ", true],
      [47, "double  inner  spaces", false],
    ]);
    const split = paragraphStarting(view.body, "Matrix");
    expect(split.runs.map((run) => [run.text, run.italic]).slice(0, 2)).toEqual([
      ["Mat", false],
      ["rix", true],
    ]);
    expect(paragraphStarting(view.body, "ש").style.alignment).toBe("right");
  });
});
