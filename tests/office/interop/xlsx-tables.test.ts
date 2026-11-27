/**
 * Tables move with their sheet.
 *
 * A table is a part of its own that names its range and its columns.
 * Spreadsheet software repairs or refuses a workbook whose table does not
 * sit on its header row, or whose column names differ from the header
 * cells. The engine kept table parts byte for byte, so inserting a row above
 * a table, or retyping a header, produced such a workbook.
 */

import { describe, expect, it } from "vitest";
import type { Workbook } from "../../../packages/office/src/index.js";
import { createXlsx, isOfficeError, openXlsx, opc, parseA1, parseA1Range } from "../../../packages/office/src/index.js";
import { attr, readPackage } from "./package.js";
import { sheetProblems } from "./sml-rules.js";

const TABLE_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml";
const TABLE_RELATIONSHIP = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/table";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** A workbook with an `Orders` table on B3:D7 (a header and four rows) and a formula under it. */
async function workbookWithTable(): Promise<Workbook> {
  const workbook = createXlsx({ sheetNames: ["Orders", "Other"] });
  const sheet = workbook.listSheets()[0];
  if (sheet === undefined) throw new Error("no sheet");
  workbook.setRange(sheet.id, parseA1("B3"), [
    ["Order", "Customer", "Qty"],
    ["O-1", "Ana", 3],
    ["O-2", "Ben", 5],
    ["O-3", "Chloé", 8],
    ["O-4", "Dev", 13],
  ]);
  workbook.setFormula(sheet.id, parseA1("D9"), "SUM(D4:D7)");
  const pkg = await opc.openPackage(await workbook.save());
  const sheetPart = "/xl/worksheets/sheet1.xml";
  pkg.setPart(
    "/xl/tables/table1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="OrdersTable" displayName="OrdersTable" ref="B3:D7" totalsRowShown="0"><autoFilter ref="B3:D7"/><tableColumns count="3"><tableColumn id="1" name="Order"/><tableColumn id="2" name="Customer"/><tableColumn id="3" name="Qty"/></tableColumns><tableStyleInfo name="TableStyleMedium9" showRowStripes="1"/></table>`,
    TABLE_TYPE,
  );
  const relationship = pkg.addRelationship(sheetPart, { type: TABLE_RELATIONSHIP, target: "../tables/table1.xml" });
  const xml = await pkg.getPartText(sheetPart);
  pkg.setPart(sheetPart, xml.replace("</worksheet>", `<tableParts count="1"><tablePart xmlns:r="${R}" r:id="${relationship.id}"/></tableParts></worksheet>`));
  return openXlsx(await pkg.save());
}

async function table(workbook: Workbook): Promise<{ ref: string | null; filter: string | null; columns: Array<string | null>; problems: string[] }> {
  const bytes = await workbook.save();
  const root = (await readPackage(bytes)).parts.get("/xl/tables/table1.xml")?.root;
  if (root === undefined) throw new Error("no table part");
  const elements = root.children.filter((node) => node.kind === "element");
  const filter = elements.find((node) => node.kind === "element" && node.name === "autoFilter");
  const list = elements.find((node) => node.kind === "element" && node.name === "tableColumns");
  const columns = list === undefined || list.kind !== "element" ? [] : list.children.filter((node) => node.kind === "element").map((node) => (node.kind === "element" ? attr(node, "name") : null));
  return { ref: attr(root, "ref"), filter: filter === undefined || filter.kind !== "element" ? null : attr(filter, "ref"), columns, problems: await sheetProblems(bytes) };
}

function orders(workbook: Workbook): string {
  const sheet = workbook.getSheetByName("Orders");
  if (sheet === null) throw new Error("no sheet");
  return sheet.id;
}

function refusal(action: () => void): string {
  try {
    action();
  } catch (error) {
    if (isOfficeError(error)) return error.code;
    throw error;
  }
  return "no error";
}

describe("a table on a sheet", () => {
  it("starts valid", async () => {
    expect(await table(await workbookWithTable())).toEqual({ ref: "B3:D7", filter: "B3:D7", columns: ["Order", "Customer", "Qty"], problems: [] });
  });

  it("moves with rows and columns inserted and deleted around it", async () => {
    const workbook = await workbookWithTable();
    const sheet = orders(workbook);
    workbook.insertRows(sheet, 0, 2);
    expect(await table(workbook)).toMatchObject({ ref: "B5:D9", filter: "B5:D9", problems: [] });
    workbook.insertColumns(sheet, 0, 1);
    expect(await table(workbook)).toMatchObject({ ref: "C5:E9", filter: "C5:E9", problems: [] });
    workbook.deleteRows(sheet, 1, 1);
    workbook.deleteColumns(sheet, 1, 1);
    expect(await table(workbook)).toMatchObject({ ref: "B4:D8", filter: "B4:D8", problems: [] });
    // Rows and columns after the table leave it where it is.
    workbook.insertRows(sheet, 8, 3);
    workbook.insertColumns(sheet, 4, 2);
    expect(await table(workbook)).toMatchObject({ ref: "B4:D8", problems: [] });
  });

  it("grows and shrinks with rows inserted and deleted among its data", async () => {
    const workbook = await workbookWithTable();
    const sheet = orders(workbook);
    workbook.insertRows(sheet, 4, 2);
    expect(await table(workbook)).toMatchObject({ ref: "B3:D9", filter: "B3:D9", problems: [] });
    expect(workbook.getCell(sheet, parseA1("D11")).formula).toBe("SUM(D4:D9)");
    workbook.deleteRows(sheet, 3, 3);
    expect(await table(workbook)).toMatchObject({ ref: "B3:D6", filter: "B3:D6", problems: [] });
  });

  it("refuses an edit that would cut it apart, and stays as it was", async () => {
    const workbook = await workbookWithTable();
    const sheet = orders(workbook);
    expect(refusal(() => workbook.insertColumns(sheet, 2, 1))).toBe("invalid_operation");
    expect(refusal(() => workbook.deleteColumns(sheet, 3, 1))).toBe("invalid_operation");
    expect(refusal(() => workbook.deleteRows(sheet, 2, 1))).toBe("invalid_operation");
    expect(refusal(() => workbook.deleteRows(sheet, 1, 3))).toBe("invalid_operation");
    expect(refusal(() => workbook.deleteRows(sheet, 3, 4))).toBe("invalid_operation");
    expect(workbook.getCell(sheet, parseA1("B3")).value).toBe("Order");
    expect(workbook.getCell(sheet, parseA1("D7")).value).toBe(13);
    expect(await table(workbook)).toEqual({ ref: "B3:D7", filter: "B3:D7", columns: ["Order", "Customer", "Qty"], problems: [] });
  });

  it("renames a column when its header cell is retyped", async () => {
    const workbook = await workbookWithTable();
    const sheet = orders(workbook);
    workbook.setCell(sheet, parseA1("C3"), "Client & <Co>");
    workbook.setCellInput(sheet, parseA1("D3"), "Units");
    expect(await table(workbook)).toMatchObject({ columns: ["Order", "Client & <Co>", "Units"], problems: [] });
    const reopened = await openXlsx(await workbook.save());
    expect(reopened.getCell(orders(reopened), parseA1("C3")).value).toBe("Client & <Co>");
  });

  it("refuses a header that other software would not accept", async () => {
    const workbook = await workbookWithTable();
    const sheet = orders(workbook);
    expect(refusal(() => workbook.setCell(sheet, parseA1("C3"), 42))).toBe("invalid_operation");
    expect(refusal(() => workbook.setCell(sheet, parseA1("C3"), ""))).toBe("invalid_operation");
    expect(refusal(() => workbook.setCell(sheet, parseA1("C3"), "qty"))).toBe("invalid_operation");
    expect(refusal(() => workbook.setFormula(sheet, parseA1("C3"), "1+1"))).toBe("invalid_operation");
    expect(refusal(() => workbook.setCellInput(sheet, parseA1("C3"), ""))).toBe("invalid_operation");
    expect(refusal(() => workbook.clearRange(sheet, parseA1Range("A1:C3")))).toBe("invalid_operation");
    // A merge shows only its top-left cell, so merging across headers would clear them.
    expect(refusal(() => workbook.mergeCells(sheet, parseA1Range("B3:D3")))).toBe("invalid_operation");
    expect(refusal(() => workbook.mergeCells(sheet, parseA1Range("A2:C3")))).toBe("invalid_operation");
    expect(workbook.getSheet(sheet).mergedRanges).toEqual([]);
    expect(workbook.getCell(sheet, parseA1("C3")).value).toBe("Customer");
    // A range write that would give two columns one name changes nothing.
    expect(refusal(() => workbook.setRange(sheet, parseA1("A3"), [["x", "Same", "same", "Qty"]]))).toBe("invalid_operation");
    expect(workbook.getCell(sheet, parseA1("A3")).value).toBeNull();
    expect(await table(workbook)).toEqual({ ref: "B3:D7", filter: "B3:D7", columns: ["Order", "Customer", "Qty"], problems: [] });
    // A header in the top-left cell of a merge keeps its content.
    workbook.mergeCells(sheet, parseA1Range("D3:E3"));
    expect(workbook.getCell(sheet, parseA1("D3")).value).toBe("Qty");
    workbook.unmergeCells(sheet, parseA1Range("D3:E3"));
    // Formats may be cleared, and a range write of valid headers goes through.
    workbook.clearRange(sheet, parseA1Range("A1:D3"), "formats");
    workbook.setRange(sheet, parseA1("B3"), [["Id", "Who", "How many"]]);
    expect(await table(workbook)).toMatchObject({ columns: ["Id", "Who", "How many"], problems: [] });
  });

  it("follows a proposal that is rejected", async () => {
    const workbook = await workbookWithTable();
    const sheet = orders(workbook);
    workbook.beginProposal({ author: "Matrix Agent", date: "2026-11-23T10:00:00Z", label: "Rename" });
    workbook.setCell(sheet, parseA1("C3"), "Client");
    workbook.endProposal();
    expect(await table(workbook)).toMatchObject({ columns: ["Order", "Client", "Qty"], problems: [] });
    workbook.rejectChanges("all");
    expect(await table(workbook)).toMatchObject({ columns: ["Order", "Customer", "Qty"], problems: [] });

    workbook.beginProposal({ author: "Matrix Agent", date: "2026-11-23T10:00:00Z", label: "Rows" });
    workbook.insertRows(sheet, 0, 2);
    workbook.endProposal();
    expect(await table(workbook)).toMatchObject({ ref: "B5:D9", problems: [] });
    workbook.rejectChanges("all");
    expect(await table(workbook)).toMatchObject({ ref: "B3:D7", problems: [] });
  });

  it("goes with its sheet", async () => {
    const workbook = await workbookWithTable();
    workbook.removeSheet(orders(workbook));
    const bytes = await workbook.save();
    expect([...(await readPackage(bytes)).parts.keys()].filter((name) => name.includes("table"))).toEqual([]);
    expect(await sheetProblems(bytes)).toEqual([]);
  });
});
