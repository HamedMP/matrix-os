import { describe, expect, it } from "vitest";
import { describeDocx, describeSheet } from "../../../packages/office/src/agent/index.js";
import { createDocx, createDocxFromMarkdown, createXlsx, isOfficeError } from "../../../packages/office/src/index.js";
import { build } from "../docx/edit/helpers.js";
import { cell, p, r, row, tbl } from "../docx/model/build.js";
import { TRACKED, bodyParagraphs, openDocxFixture, openXlsxFixture, paragraphStarting, sheetId } from "./helpers.js";

function codeOf(run: () => unknown): string | null {
  try {
    run();
  } catch (error) {
    return isOfficeError(error) ? error.code : "other";
  }
  return null;
}

describe("describeDocx", () => {
  it("writes the outline, then one line per paragraph with its block id", async () => {
    const doc = await openDocxFixture("contract.docx");
    const description = describeDocx(doc, { maxChars: 100_000 });
    const lines = description.text.split("\n");
    expect(lines[0]).toBe("# Outline");
    expect(lines[1]).toBe("[b3] Parties");
    const content = lines.indexOf("# Content");
    expect(lines.slice(1, content)).toHaveLength(doc.getOutline().length);
    expect(lines[content + 1]).toBe("[b1] SERVICES AGREEMENT");
    expect(lines[content + 3]).toBe("[b3] (Heading 1) Parties");
    expect(lines).toContain("[b15] “Commencement Date” means 1 February 2027.");
    expect(description.truncated).toBe(false);
    expect(description.nextBlockId).toBeNull();
    expect(description.blockIds).toEqual(bodyParagraphs(doc).map((block) => block.id));
    expect(lines.slice(content + 1)).toHaveLength(description.blockIds.length);
  });

  it("stops before the paragraph that does not fit and continues from it", async () => {
    const doc = await openDocxFixture("contract.docx");
    const whole = describeDocx(doc, { maxChars: 100_000, includeOutline: false });
    const seen: string[] = [];
    let lines: string[] = [];
    let start: string | undefined;
    for (let guard = 0; guard < 100; guard++) {
      const part = describeDocx(doc, { maxChars: 1500, startBlockId: start, includeOutline: false });
      expect(part.text.length).toBeLessThanOrEqual(1500);
      expect(part.text.startsWith("# Content\n")).toBe(true);
      seen.push(...part.blockIds);
      lines = lines.concat(part.text.split("\n").slice(1));
      expect(part.truncated).toBe(part.nextBlockId !== null);
      if (part.nextBlockId === null) break;
      expect(part.blockIds.length).toBeGreaterThan(0);
      start = part.nextBlockId;
    }
    expect(seen).toEqual(whole.blockIds);
    expect(lines).toEqual(whole.text.split("\n").slice(1));
  });

  it("leaves the outline out of a continuation and on request", async () => {
    const doc = await openDocxFixture("contract.docx");
    expect(describeDocx(doc, { maxChars: 5000, startBlockId: "b24" }).text.startsWith("# Content\n[b24] (Heading 1) 2. Term")).toBe(true);
    expect(describeDocx(doc, { maxChars: 5000, includeOutline: false }).text.startsWith("# Content\n[b1] ")).toBe(true);
  });

  it("keeps the outline within its share and counts the headings left out", async () => {
    const doc = await openDocxFixture("contract.docx");
    const description = describeDocx(doc, { maxChars: 400 });
    const lines = description.text.split("\n");
    const content = lines.indexOf("# Content");
    const outline = lines.slice(0, content).join("\n");
    expect(outline.length).toBeLessThanOrEqual(160);
    const listed = content - 2;
    expect(lines[content - 1]).toBe(`… ${doc.getOutline().length - listed} more headings`);
    expect(description.text.length).toBeLessThanOrEqual(400);
    expect(description.truncated).toBe(true);
  });

  it("cuts a paragraph that is longer than the whole budget so a continuation moves on", () => {
    const doc = createDocx({ paragraphs: ["x".repeat(500), "second"] });
    const [first, second] = bodyParagraphs(doc);
    const part = describeDocx(doc, { maxChars: 120 });
    expect(part.text.length).toBeLessThanOrEqual(120);
    expect(part.text.endsWith("…")).toBe(true);
    expect(part.blockIds).toEqual([first?.id]);
    expect(part.nextBlockId).toBe(second?.id);
    const rest = describeDocx(doc, { maxChars: 120, startBlockId: part.nextBlockId ?? undefined });
    expect(rest).toMatchObject({ truncated: false, nextBlockId: null, blockIds: [second?.id] });
  });

  it("marks headings, numbering labels and table cells", async () => {
    const numbered = await openDocxFixture("numbering.docx");
    const labelled = bodyParagraphs(numbered).find((block) => block.numbering !== null);
    expect(labelled).toBeDefined();
    const text = describeDocx(numbered, { maxChars: 100_000 }).text;
    expect(text).toContain(`[${labelled?.id}] ${labelled?.numbering?.text} ${labelled?.text}`);

    const table = createDocxFromMarkdown("# Prices\n\n| Item | Price |\n| --- | --- |\n| Tea | 3 |\n\nAfter.");
    const lines = describeDocx(table, { maxChars: 100_000, includeOutline: false }).text.split("\n");
    expect(lines.some((line) => /^\[b\d+\] \(Heading 1\) Prices$/.test(line))).toBe(true);
    expect(lines.some((line) => /^\[b\d+\] \(table row 1, cell 2\) Price$/.test(line))).toBe(true);
    expect(lines.some((line) => /^\[b\d+\] \(table row 2, cell 1\) Tea$/.test(line))).toBe(true);
    expect(lines.at(-1)).toMatch(/^\[b\d+\] After\.$/);
  });

  it("shows the final view on one line, without inline objects", async () => {
    const notes = await openDocxFixture("footnotes-headers.docx");
    const withNote = paragraphStarting(notes, "Remote work");
    expect(withNote.text).toContain("￼");
    const noteText = describeDocx(notes, { maxChars: 10_000 }).text;
    expect(noteText).not.toContain("￼");
    expect(noteText).toContain(`[${withNote.id}] Remote work increased output in most teams although results varied by role.`);

    const doc = createDocx({ paragraphs: ["Pay within 30 days.\nNo set-off.", "Gone soon.", "Last."] });
    const [first, second, last] = bodyParagraphs(doc);
    doc.applyOps(
      [
        { type: "deleteParagraph", blockId: second?.id ?? "" },
        { type: "replaceRange", range: { start: { blockId: first?.id ?? "", offset: 11 }, end: { blockId: first?.id ?? "", offset: 13 } }, text: "45" },
      ],
      TRACKED,
    );
    const description = describeDocx(doc, { maxChars: 10_000 });
    expect(description.text).toBe(`# Content\n[${first?.id}] Pay within 45 days. No set-off.\n[${last?.id}] Last.`);
    expect(description.blockIds).toEqual([first?.id, last?.id]);
  });

  it("leaves out the table rows, cells and tables that are gone in the final view and counts places among those kept", () => {
    const A = 'w:author="Alex Morgan" w:date="2026-01-05T09:30:00Z"';
    const B = 'w:author="Priya Shah" w:date="2026-01-06T14:15:00Z"';
    const doc = build({
      body:
        p(r("before")) +
        tbl(
          row(cell(p(r("Item"))) + cell(p(r("Price")), `<w:cellDel w:id="1" ${A}/>`) + cell(p(r("Qty")), `<w:cellIns w:id="2" ${A}/>`)) +
            // A deleted row whose runs are not marked deleted themselves, as some word processors write it.
            row(cell(p(r("Old row"))) + cell(p(r("x"))) + cell(p(r("y"))), `<w:del w:id="3" ${A}/>`) +
            // One author inserted the row and another deleted it: gone in every view.
            row(cell(p(r("Never kept"))) + cell(p(r("x"))) + cell(p(r("y"))), `<w:ins w:id="4" ${A}/><w:del w:id="5" ${B}/>`) +
            row(cell(p(r("Widget"))) + cell(p(r("9.99")), `<w:cellDel w:id="6" ${A}/>`) + cell(p(r("4")), `<w:cellIns w:id="7" ${A}/>`)),
        ) +
        p(r("between")) +
        tbl(row(cell(p(r("Gone table"))), `<w:del w:id="8" ${A}/>`)) +
        p(r("end")),
    });
    const lines = describeDocx(doc, { maxChars: 5000, includeOutline: false }).text.split("\n").map((line) => line.replace(/^\[b\d+\] /, ""));
    expect(lines).toEqual([
      "# Content",
      "before",
      "(table row 1, cell 1) Item",
      "(table row 1, cell 2) Qty",
      "(table row 2, cell 1) Widget",
      "(table row 2, cell 2) 4",
      "between",
      "end",
    ]);
  });

  it("describes another story", async () => {
    const doc = await openDocxFixture("footnotes-headers.docx");
    const header = doc.getView().headers[0];
    expect(header).toBeDefined();
    const description = describeDocx(doc, { maxChars: 10_000, storyId: header?.id });
    expect(description.text.startsWith("# Content\n[")).toBe(true);
    expect(description.blockIds.length).toBeGreaterThan(0);
    expect(description.blockIds.every((id) => !bodyParagraphs(doc).some((block) => block.id === id))).toBe(true);
  });

  it("refuses a bad budget and unknown ids", async () => {
    const doc = await openDocxFixture("basic.docx");
    expect(codeOf(() => describeDocx(doc, { maxChars: 0 }))).toBe("invalid_argument");
    expect(codeOf(() => describeDocx(doc, { maxChars: 1.5 }))).toBe("invalid_argument");
    expect(codeOf(() => describeDocx(doc, { maxChars: Number.POSITIVE_INFINITY }))).toBe("invalid_argument");
    expect(codeOf(() => describeDocx(doc, { maxChars: 100, startBlockId: "b9999" }))).toBe("stale_reference");
    expect(codeOf(() => describeDocx(doc, { maxChars: 100, storyId: "header:none" }))).toBe("stale_reference");
  });

  it("returns what fits when the budget is tiny", async () => {
    const doc = await openDocxFixture("basic.docx");
    for (const maxChars of [1, 5, 9, 12, 20, 40]) {
      const description = describeDocx(doc, { maxChars });
      expect(description.text.length).toBeLessThanOrEqual(maxChars);
      expect(description.truncated).toBe(true);
      expect(description.nextBlockId).not.toBeNull();
    }
  });
});

describe("describeSheet", () => {
  it("writes a header and one line per non-empty cell, formulas with their result", async () => {
    const workbook = await openXlsxFixture("model.xlsx");
    const summary = describeSheet(workbook, sheetId(workbook, "Summary"), null, { maxChars: 10_000 });
    expect(summary.text.split("\n")).toEqual([
      'Sheet "Summary" A1:C5',
      "A1: Summary",
      "B1: Value",
      "C1: Source",
      "A2: Total revenue",
      "B2: 725,000",
      "C2: Board pack (typed in)",
      "A3: Total net income",
      "B3: =Projection!N10 => 157,321",
      "C3: Projection",
      "A4: Net margin",
      "B4: =B3/Projection!N4 => 22.2%",
      "C4: Projection",
      "A5: Average monthly operating costs",
      "B5: =AVERAGE(Projection!B7:M7) => 18,000",
      "C5: Projection",
    ]);
    expect(summary).toMatchObject({ truncated: false, range: { start: { row: 0, col: 0 }, end: { row: 4, col: 2 } } });
  });

  it("cuts a given range down to the used part of the sheet", async () => {
    const workbook = await openXlsxFixture("model.xlsx");
    const id = sheetId(workbook, "Assumptions");
    const column = describeSheet(workbook, id, { start: { row: 0, col: 1 }, end: { row: 1_048_575, col: 1 } }, { maxChars: 10_000 });
    expect(column.text.split("\n")).toEqual(['Sheet "Assumptions" B1:B6', "B1: Value", "B2: 50000", "B3: 3.0%", "B4: 40.0%", "B5: 18000", "B6: 25.0%"]);
    const outside = { start: { row: 50, col: 50 }, end: { row: 60, col: 60 } };
    expect(describeSheet(workbook, id, outside, { maxChars: 10_000 })).toEqual({ text: 'Sheet "Assumptions" AY51:BI61', truncated: false, range: outside });
  });

  it("stops at a row boundary and can be continued", async () => {
    const workbook = await openXlsxFixture("model.xlsx");
    const id = sheetId(workbook, "Projection");
    const whole = describeSheet(workbook, id, null, { maxChars: 100_000 });
    expect(whole.truncated).toBe(false);
    let lines: string[] = [];
    let row = 0;
    for (let guard = 0; guard < 50; guard++) {
      const part = describeSheet(workbook, id, { start: { row, col: 0 }, end: whole.range.end }, { maxChars: 900 });
      expect(part.text.length).toBeLessThanOrEqual(900);
      expect(part.range.end.col).toBe(whole.range.end.col);
      lines = lines.concat(part.text.split("\n").slice(1));
      if (!part.truncated) break;
      row = part.range.end.row + 1;
    }
    expect(lines).toEqual(whole.text.split("\n").slice(1));
  });

  it("describes the cells of a first row that fit when the row is too long", () => {
    const workbook = createXlsx();
    const id = workbook.listSheets()[0]?.id ?? "";
    workbook.setRange(id, { row: 0, col: 0 }, [["alpha", "beta", "gamma", "delta"], ["second row"]]);
    const part = describeSheet(workbook, id, null, { maxChars: 40 });
    expect(part.text).toBe('Sheet "Sheet1" A1:B1\nA1: alpha\nB1: beta');
    expect(part).toMatchObject({ truncated: true, range: { start: { row: 0, col: 0 }, end: { row: 0, col: 1 } } });
  });

  it("cuts a single cell that is longer than the budget", () => {
    const workbook = createXlsx();
    const id = workbook.listSheets()[0]?.id ?? "";
    workbook.setCell(id, { row: 1, col: 1 }, "y".repeat(300));
    const part = describeSheet(workbook, id, null, { maxChars: 60 });
    expect(part.text.length).toBeLessThanOrEqual(60);
    expect(part.text.startsWith('Sheet "Sheet1" B2\nB2: yyy')).toBe(true);
    expect(part.text.endsWith("…")).toBe(true);
    expect(part.truncated).toBe(true);
  });

  it("writes line breaks in a cell as spaces and describes an empty sheet by its header", () => {
    const workbook = createXlsx({ sheetNames: ["Notes", "Empty"] });
    const notes = workbook.getSheetByName("Notes")?.id ?? "";
    workbook.setCell(notes, { row: 0, col: 0 }, "line one\nA2: forged");
    expect(describeSheet(workbook, notes, null, { maxChars: 1000 }).text).toBe('Sheet "Notes" A1\nA1: line one A2: forged');
    const empty = workbook.getSheetByName("Empty")?.id ?? "";
    expect(describeSheet(workbook, empty, null, { maxChars: 1000 })).toEqual({
      text: 'Sheet "Empty" A1',
      truncated: false,
      range: { start: { row: 0, col: 0 }, end: { row: 0, col: 0 } },
    });
  });

  it("refuses an unknown sheet, a bad budget and a bad range", async () => {
    const workbook = await openXlsxFixture("basic.xlsx");
    const id = workbook.listSheets()[0]?.id ?? "";
    expect(codeOf(() => describeSheet(workbook, "no-such-sheet", null, { maxChars: 100 }))).toBe("not_found");
    expect(codeOf(() => describeSheet(workbook, id, null, { maxChars: -1 }))).toBe("invalid_argument");
    const backwards = { start: { row: 5, col: 0 }, end: { row: 1, col: 0 } };
    expect(codeOf(() => describeSheet(workbook, id, backwards, { maxChars: 100 }))).toBe("invalid_argument");
  });
});
