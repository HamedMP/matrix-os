import { describe, expect, it } from "vitest";

import type { DocxDocument, TableBlock } from "../../../../packages/office/src/api/docx.js";
import { isOfficeError } from "../../../../packages/office/src/errors.js";
import { cell, p, r, row, tbl } from "../model/build.js";
import { DATE, DIRECT, RAE, TRACKED, blockXml, build, openFixture, paragraphs, reopen, text } from "./helpers.js";

const HEADER = row(
  cell(p(r("Item", "<w:b/>"), '<w:jc w:val="center"/>'), '<w:tcW w:w="2400" w:type="dxa"/>') +
    cell(p(r("Qty", "<w:b/>")), '<w:tcW w:w="1200" w:type="dxa"/><w:shd w:val="clear" w:fill="EEEEEE"/>'),
  "<w:tblHeader/>",
);
const DATA = row(
  cell(p(r("Widgets")), '<w:tcW w:w="2400" w:type="dxa"/>') + cell(p(r("10")), '<w:tcW w:w="1200" w:type="dxa"/>'),
  '<w:trHeight w:val="300"/>',
);

function make(rows = HEADER + DATA): { doc: DocxDocument; table: () => TableBlock; id: string } {
  const doc = build({ body: p(r("Before")) + tbl(rows, '<w:gridCol w:w="2400"/><w:gridCol w:w="1200"/>') + p(r("After")) });
  const id = doc.getView().body.blocks.find((block) => block.type === "table")?.id as string;
  const table = (): TableBlock => {
    const block = doc.getBlock(id);
    if (block?.type !== "table") throw new Error("no table");
    return block;
  };
  return { doc, table, id };
}

const cellText = (table: TableBlock): string[][] =>
  table.rows.map((entry) => entry.cells.map((item) => item.blocks.map((block) => (block.type === "paragraph" ? block.text : "")).join("|")));

function code(doc: DocxDocument, op: unknown, options = DIRECT): string {
  try {
    doc.applyOps([op as never], options);
  } catch (error) {
    return isOfficeError(error) ? error.code : "other";
  }
  return "none";
}

describe("insertTableRow", () => {
  it("copies the structure and properties of the row before it, without the header flag", () => {
    const { doc, table, id } = make();
    const result = doc.applyOps([{ type: "insertTableRow", tableId: id, rowIndex: 1, cells: ["Gadgets", "4"] }], DIRECT);
    expect(cellText(table())).toEqual([["Item", "Qty"], ["Gadgets", "4"], ["Widgets", "10"]]);
    expect(blockXml(doc, id)).toContain(
      '<w:tr><w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr><w:p><w:pPr><w:jc w:val="center"/></w:pPr>' +
        "<w:r><w:rPr><w:b/></w:rPr><w:t>Gadgets</w:t></w:r></w:p></w:tc>" +
        '<w:tc><w:tcPr><w:tcW w:w="1200" w:type="dxa"/><w:shd w:val="clear" w:fill="EEEEEE"/></w:tcPr>' +
        "<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>4</w:t></w:r></w:p></w:tc></w:tr>",
    );
    expect(table().rows.map((entry) => entry.isHeader)).toEqual([true, false, false]);
    const created = table().rows[1]?.cells.map((item) => item.blocks[0]?.id);
    expect(result.createdBlockIds).toEqual(created);
    expect(result.changedBlockIds).toEqual([id]);
    expect(result.results[0]?.caret).toEqual({ blockId: created?.[0], offset: 0 });
  });

  it("inserts first and last, with missing cells left empty", () => {
    const { doc, table, id } = make();
    doc.applyOps(
      [
        { type: "insertTableRow", tableId: id, rowIndex: 2, cells: ["Last"] },
        { type: "insertTableRow", tableId: id, rowIndex: 0 },
      ],
      DIRECT,
    );
    expect(cellText(table())).toEqual([["", ""], ["Item", "Qty"], ["Widgets", "10"], ["Last", ""]]);
    expect(blockXml(doc, id)).toContain('<w:tr><w:trPr><w:trHeight w:val="300"/></w:trPr><w:tc>');
  });

  it("marks the new row, its paragraph marks and its text as inserted", async () => {
    const { doc, table, id } = make();
    const result = doc.applyOps([{ type: "insertTableRow", tableId: id, rowIndex: 2, cells: ["Gadgets", "4"] }], TRACKED);
    const stamp = `w:author="${RAE}" w:date="${DATE}"`;
    expect(blockXml(doc, id)).toMatch(
      new RegExp(
        `<w:tr><w:trPr><w:trHeight w:val="300"/><w:ins w:id="\\d+" ${stamp}/></w:trPr><w:tc><w:tcPr>.*?</w:tcPr>` +
          `<w:p><w:pPr><w:rPr><w:ins w:id="\\d+" ${stamp}/></w:rPr></w:pPr><w:ins w:id="\\d+" ${stamp}><w:r><w:t>Gadgets</w:t></w:r></w:ins></w:p>`,
      ),
    );
    expect(table().rows[2]?.revision).toMatchObject({ kind: "insert", author: RAE });
    const revisions = doc.listRevisions();
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ kind: "insert", scope: "tableRow", text: "Gadgets\t4" });
    expect(result.revisionIds).toEqual([revisions[0]?.id]);
    expect(text(doc, "final")).toBe("Before\nItem\tQty\nWidgets\t10\nGadgets\t4\nAfter\n");
    expect(text(doc, "original")).toBe("Before\nItem\tQty\nWidgets\t10\nAfter\n");
    const rejected = await reopen(doc);
    rejected.rejectRevisions("all");
    expect(text(rejected, "markup")).toBe("Before\nItem\tQty\nWidgets\t10\nAfter\n");
    doc.acceptRevisions("all");
    expect(blockXml(doc, id)).not.toMatch(/w:ins|w:pPr><w:rPr/);
    expect(cellText(table())).toEqual([["Item", "Qty"], ["Widgets", "10"], ["Gadgets", "4"]]);
  });

  it("continues a vertical merge that runs through the new row", () => {
    const merged = (value: string, textValue: string): string => cell(p(r(textValue)), `<w:tcW w:w="2400" w:type="dxa"/><w:vMerge${value}/>`);
    const { doc, id } = make(
      row(merged(' w:val="restart"', "A") + cell(p(r("1")))) + row(merged("", "") + cell(p(r("2")))) + row(cell(p(r("B"))) + cell(p(r("3")))),
    );
    doc.applyOps(
      [
        { type: "insertTableRow", tableId: id, rowIndex: 3 },
        { type: "insertTableRow", tableId: id, rowIndex: 2 },
        { type: "insertTableRow", tableId: id, rowIndex: 1 },
      ],
      DIRECT,
    );
    const block = doc.getBlock(id);
    if (block?.type !== "table") throw new Error("no table");
    expect(block.rows.map((entry) => entry.cells[0]?.mergedAbove)).toEqual([false, true, true, false, false, false]);
    expect(block.rows[0]?.cells[0]?.rowSpan).toBe(3);
  });

  it("rejects a bad index, too many cells and a block that is not a table", () => {
    const { doc, id } = make();
    const paragraph = paragraphs(doc)[0]?.id as string;
    expect(code(doc, { type: "insertTableRow", tableId: id, rowIndex: 3 })).toBe("invalid_operation");
    expect(code(doc, { type: "insertTableRow", tableId: id, rowIndex: -1 })).toBe("invalid_operation");
    expect(code(doc, { type: "insertTableRow", tableId: id, rowIndex: 1.5 })).toBe("invalid_argument");
    expect(code(doc, { type: "insertTableRow", tableId: id, rowIndex: 1, cells: ["a", "b", "c"] })).toBe("invalid_operation");
    expect(code(doc, { type: "insertTableRow", tableId: id, rowIndex: 1, cells: ["a\u0001"] })).toBe("invalid_argument");
    expect(code(doc, { type: "insertTableRow", tableId: paragraph, rowIndex: 0 })).toBe("invalid_operation");
    expect(code(doc, { type: "insertTableRow", tableId: "missing", rowIndex: 0 })).toBe("stale_reference");
  });
});

describe("deleteTableRow", () => {
  it("removes the row directly and moves positions to the next row", () => {
    const { doc, table, id } = make(HEADER + DATA + row(cell(p(r("Bolts"))) + cell(p(r("7")))));
    const inRow = table().rows[1]?.cells[1]?.blocks[0]?.id as string;
    const next = table().rows[2]?.cells[0]?.blocks[0]?.id as string;
    const result = doc.applyOps([{ type: "deleteTableRow", tableId: id, rowIndex: 1 }], { ...DIRECT, positions: [{ blockId: inRow, offset: 1 }] });
    expect(cellText(table())).toEqual([["Item", "Qty"], ["Bolts", "7"]]);
    expect(result.removedBlockIds).toHaveLength(2);
    expect(result.positions).toEqual([{ blockId: next, offset: 0 }]);
    expect(result.results[0]?.caret).toEqual({ blockId: next, offset: 0 });
    expect(result.changedBlockIds).toEqual([id]);
  });

  it("marks the row and its content as deleted", () => {
    const { doc, table, id } = make();
    const result = doc.applyOps([{ type: "deleteTableRow", tableId: id, rowIndex: 1 }], TRACKED);
    expect(blockXml(doc, id)).toMatch(
      /<w:tr><w:trPr><w:trHeight w:val="300"\/><w:del w:id="\d+" [^>]*\/><\/w:trPr><w:tc><w:tcPr>.*?<\/w:tcPr><w:p><w:pPr><w:rPr><w:del [^>]*\/><\/w:rPr><\/w:pPr><w:del [^>]*><w:r><w:delText[^>]*>Widgets<\/w:delText>/,
    );
    expect(table().rows[1]?.revision).toMatchObject({ kind: "delete", author: RAE });
    const revisions = doc.listRevisions();
    expect(revisions.map((revision) => [revision.kind, revision.scope, revision.text])).toEqual([["delete", "tableRow", "Widgets\t10"]]);
    expect(result.revisionIds).toEqual([revisions[0]?.id]);
    expect(text(doc, "final")).toBe("Before\nItem\tQty\nAfter\n");
    expect(text(doc, "original")).toBe("Before\nItem\tQty\nWidgets\t10\nAfter\n");
    const snapshot = doc.snapshot();
    doc.acceptRevisions("all");
    expect(cellText(table())).toEqual([["Item", "Qty"]]);
    doc.restore(snapshot);
    doc.rejectRevisions("all");
    expect(cellText(table())).toEqual([["Item", "Qty"], ["Widgets", "10"]]);
    expect(blockXml(doc, id)).not.toMatch(/w:del|delText/);
  });

  it("removes a row the same author inserted outright", () => {
    const { doc, table, id } = make();
    const before = blockXml(doc, id);
    doc.applyOps([{ type: "insertTableRow", tableId: id, rowIndex: 2, cells: ["Gadgets", "4"] }], TRACKED);
    doc.applyOps([{ type: "deleteTableRow", tableId: id, rowIndex: 2 }], TRACKED);
    expect(blockXml(doc, id)).toBe(before);
    expect(doc.listRevisions()).toEqual([]);
    expect(table().rows).toHaveLength(2);
  });

  it("never deletes the last row, counting rows already marked deleted as gone", () => {
    const { doc, id } = make();
    expect(code(doc, { type: "deleteTableRow", tableId: id, rowIndex: 5 })).toBe("invalid_operation");
    doc.applyOps([{ type: "deleteTableRow", tableId: id, rowIndex: 0 }], TRACKED);
    expect(code(doc, { type: "deleteTableRow", tableId: id, rowIndex: 1 }, TRACKED)).toBe("invalid_operation");
    doc.applyOps([{ type: "deleteTableRow", tableId: id, rowIndex: 0 }], DIRECT);
    expect(code(doc, { type: "deleteTableRow", tableId: id, rowIndex: 0 })).toBe("invalid_operation");
  });
});

describe("setCellText", () => {
  it("replaces the cell content directly; the first paragraph keeps its id and properties", () => {
    const { doc, table, id } = make(row(cell(p(r("First line", "<w:i/>"), '<w:jc w:val="center"/>') + p(r("Second line")) + p(r("Third")))));
    const first = table().rows[0]?.cells[0]?.blocks[0]?.id as string;
    const result = doc.applyOps([{ type: "setCellText", tableId: id, rowIndex: 0, cellIndex: 0, text: "Only line", granularity: "whole" }], DIRECT);
    const cellBlocks = table().rows[0]?.cells[0]?.blocks ?? [];
    expect(cellBlocks).toHaveLength(1);
    expect(cellBlocks[0]).toMatchObject({ id: first, text: "Only line" });
    expect(blockXml(doc, first)).toBe('<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:i/></w:rPr><w:t>Only line</w:t></w:r></w:p>');
    expect(result.removedBlockIds).toHaveLength(2);
    expect(result.changedBlockIds).toEqual([id, first]);
    expect(result.results[0]?.caret).toEqual({ blockId: first, offset: 9 });
  });

  it("records only the words that changed by default", () => {
    const { doc, table, id } = make(row(cell(p(r("Net 30 days"))) + cell(p(r("x")))));
    doc.applyOps([{ type: "setCellText", tableId: id, rowIndex: 0, cellIndex: 0, text: "Net 45 days" }], TRACKED);
    expect(doc.listRevisions().map((revision) => [revision.kind, revision.text])).toEqual([["delete", "30"], ["insert", "45"]]);
    expect(cellText(table())).toEqual([["Net 3045 days", "x"]]);
    expect(text(doc, "final")).toBe("Before\nNet 45 days\tx\nAfter\n");
  });

  it("records the removal of the other paragraphs of the cell", async () => {
    const { doc, id } = make(row(cell(p(r("First line")) + p(r("Second line")))));
    doc.applyOps([{ type: "setCellText", tableId: id, rowIndex: 0, cellIndex: 0, text: "First row" }], TRACKED);
    expect(text(doc, "final")).toBe("Before\nFirst row\nAfter\n");
    expect(text(doc, "original")).toBe("Before\nFirst line\nSecond line\nAfter\n");
    const accepted = await reopen(doc);
    accepted.acceptRevisions("all");
    const block = accepted.getView().body.blocks.find((entry) => entry.type === "table");
    expect(block?.type === "table" && cellText(block)).toEqual([["First row"]]);
    doc.rejectRevisions("all");
    expect(text(doc, "markup")).toBe("Before\nFirst line\nSecond line\nAfter\n");
  });

  it("fills and clears a cell", () => {
    const { doc, table, id } = make(row(cell(p("")) + cell(p(r("full")))));
    doc.applyOps(
      [
        { type: "setCellText", tableId: id, rowIndex: 0, cellIndex: 0, text: "now full" },
        { type: "setCellText", tableId: id, rowIndex: 0, cellIndex: 1, text: "" },
      ],
      DIRECT,
    );
    expect(cellText(table())).toEqual([["now full", ""]]);
  });

  it("rejects indexes out of range", () => {
    const { doc, id } = make();
    expect(code(doc, { type: "setCellText", tableId: id, rowIndex: 2, cellIndex: 0, text: "x" })).toBe("invalid_operation");
    expect(code(doc, { type: "setCellText", tableId: id, rowIndex: 0, cellIndex: 2, text: "x" })).toBe("invalid_operation");
    expect(code(doc, { type: "setCellText", tableId: id, rowIndex: 0, cellIndex: "0", text: "x" })).toBe("invalid_argument");
    expect(code(doc, { type: "setCellText", tableId: id, rowIndex: 0, cellIndex: 0, text: "x", granularity: "letters" })).toBe("invalid_argument");
  });
});

describe("table edits on a real file", () => {
  it("edits the merged table fixture and keeps it readable", async () => {
    const doc = await openFixture("table.docx");
    const table = doc.getView().body.blocks.find((block) => block.type === "table");
    if (table?.type !== "table") throw new Error("no table");
    const rows = table.rows.length;
    doc.applyOps(
      [
        { type: "insertTableRow", tableId: table.id, rowIndex: rows, cells: ["Appended"] },
        { type: "setCellText", tableId: table.id, rowIndex: 1, cellIndex: 0, text: "Changed header" },
        { type: "deleteTableRow", tableId: table.id, rowIndex: rows - 1 },
      ],
      TRACKED,
    );
    const again = await reopen(doc);
    expect(again.listRevisions().length).toBeGreaterThanOrEqual(3);
    again.acceptRevisions("all");
    const after = again.getView().body.blocks.find((block) => block.type === "table");
    if (after?.type !== "table") throw new Error("no table");
    expect(after.rows).toHaveLength(rows);
    expect(cellText(after)[rows - 1]?.[0]).toBe("Appended");
    expect(cellText(after)[1]?.[0]).toBe("Changed header");
  });
});
