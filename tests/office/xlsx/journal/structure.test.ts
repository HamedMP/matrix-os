import { describe, expect, it } from "vitest";
import { parseA1Range } from "../../../../packages/office/src/xlsx/index.js";
import { AGENT, a1, at, changes, codeOf, loadFixture, resolved, sheetId, smallBook, valueAt } from "./helpers.js";
import { openXlsx } from "../../../../packages/office/src/xlsx/index.js";

describe("proposed row and column edits", () => {
  it("records inserted rows and removes them again on reject", () => {
    const { workbook, sheet } = smallBook();
    workbook.beginProposal(AGENT);
    workbook.insertRows(sheet, 1, 2);
    workbook.endProposal();
    expect(at(workbook, "Data", "A4").value).toBe(2);
    expect(at(workbook, "Data", "A6").formula).toBe("SUM(A1:A5)");
    const [change] = changes(workbook);
    expect(change).toMatchObject({ kind: "insertRows", sheet, row: 1, col: 0, summary: "Insert rows 2-3" });
    expect(workbook.getSheet(sheet).pendingChangeCount).toBe(1);
    const result = workbook.rejectChanges([change!.id]);
    expect(result.resolvedIds).toEqual([change!.id]);
    expect(valueAt(workbook, "Data", "A2")).toBe(2);
    expect(at(workbook, "Data", "A4")).toMatchObject({ formula: "SUM(A1:A3)", value: 6 });
    expect(changes(workbook)).toEqual([]);
  });

  it("restores deleted rows with their cells, formulas, heights and the references to them", () => {
    const { workbook, sheet } = smallBook();
    workbook.setCell(sheet, a1("B2"), "keep");
    workbook.setFormula(sheet, a1("C1"), "A2*10");
    workbook.setRowHeight(sheet, 1, 30);
    workbook.setDefinedName({ name: "Second", refersTo: "Data!$A$2", scope: null });
    workbook.recalc();
    workbook.beginProposal(AGENT);
    workbook.deleteRows(sheet, 1, 1);
    workbook.endProposal();
    workbook.recalc();
    expect(at(workbook, "Data", "C1").formula).toBe("#REF!*10");
    expect(at(workbook, "Data", "A3")).toMatchObject({ formula: "SUM(A1:A2)", value: 4 });
    const [change] = changes(workbook);
    expect(change).toMatchObject({ kind: "deleteRows", row: 1, summary: "Delete row 2" });
    workbook.rejectChanges("all");
    expect(valueAt(workbook, "Data", "A2")).toBe(2);
    expect(valueAt(workbook, "Data", "B2")).toBe("keep");
    expect(at(workbook, "Data", "C1")).toMatchObject({ formula: "A2*10", value: 20 });
    expect(at(workbook, "Data", "A4")).toMatchObject({ formula: "SUM(A1:A3)", value: 6 });
    expect(workbook.getSheet(sheet).rows.find((row) => row.index === 1)?.heightPt).toBe(30);
    expect(workbook.listDefinedNames().find((name) => name.name === "Second")?.refersTo).toBe("Data!$A$2");
  });

  it("restores deleted columns with widths and merged ranges", () => {
    const { workbook, sheet } = smallBook();
    workbook.setRange(sheet, a1("B1"), [["b", "c", "d"]]);
    workbook.setColumnWidth(sheet, 2, 20);
    workbook.mergeCells(sheet, parseA1Range("B3:D3"));
    workbook.beginProposal(AGENT);
    workbook.deleteColumns(sheet, 1, 2);
    workbook.endProposal();
    expect(valueAt(workbook, "Data", "B1")).toBe("d");
    workbook.rejectChanges("all");
    expect(workbook.getRange(sheet, parseA1Range("A1:D1"))[0]!.map((cell) => cell.value)).toEqual([1, "b", "c", "d"]);
    expect(workbook.getSheet(sheet).columns.find((column) => column.index === 2)?.width).toBe(20);
    expect(workbook.getSheet(sheet).mergedRanges).toEqual([parseA1Range("B3:D3")]);
  });

  it("records inserted columns and keeps them on accept", () => {
    const { workbook, sheet } = smallBook();
    workbook.beginProposal(AGENT);
    workbook.insertColumns(sheet, 0, 1);
    workbook.endProposal();
    const [change] = changes(workbook);
    expect(change).toMatchObject({ kind: "insertColumns", col: 0, summary: "Insert column A" });
    workbook.acceptChanges("all");
    expect(valueAt(workbook, "Data", "B1")).toBe(1);
    expect(workbook.getSheet(sheet).pendingChangeCount).toBe(0);
    workbook.insertRows(sheet, 0, 1);
  });

  it("refuses a second structural edit on a sheet with pending changes", () => {
    const { workbook, sheet } = smallBook();
    workbook.beginProposal(AGENT);
    workbook.insertRows(sheet, 0, 1);
    expect(codeOf(() => workbook.insertRows(sheet, 0, 1))).toBe("invalid_operation");
    expect(codeOf(() => workbook.removeSheet(sheet))).toBe("invalid_operation");
    workbook.endProposal();
  });

  it("rejecting a structural edit also rejects the later changes on its sheet", () => {
    const { workbook, sheet } = smallBook();
    workbook.beginProposal(AGENT);
    workbook.insertRows(sheet, 3, 1);
    workbook.setCell(sheet, a1("A4"), 4);
    workbook.setCell(sheet, a1("A1"), 100);
    workbook.endProposal();
    workbook.recalc();
    expect(valueAt(workbook, "Data", "A5")).toBe(105);
    const structural = changes(workbook).find((change) => change.kind === "insertRows")!;
    const result = resolved(workbook.rejectChanges([structural.id]));
    expect(result.resolvedIds).toHaveLength(3);
    expect(result.resolvedIds[result.resolvedIds.length - 1]).toBe(structural.id);
    expect(at(workbook, "Data", "A4")).toMatchObject({ formula: "SUM(A1:A3)", value: 6 });
    expect(changes(workbook)).toEqual([]);
  });

  it("rejects a mix of edits in reverse order", () => {
    const workbook = smallBook().workbook;
    const sheet = workbook.listSheets()[0]!.id;
    workbook.beginProposal(AGENT);
    workbook.setCell(sheet, a1("A1"), 50);
    const added = workbook.addSheet("Summary");
    workbook.setFormula(added.id, a1("A1"), "Data!A4*2");
    workbook.renameSheet(sheet, "Inputs");
    workbook.endProposal();
    workbook.recalc();
    expect(at(workbook, "Summary", "A1")).toMatchObject({ formula: "Inputs!A4*2", value: 110 });
    expect(changes(workbook).map((change) => change.kind).sort()).toEqual(["addSheet", "cell", "cell", "renameSheet"]);
    workbook.rejectChanges("all");
    expect(workbook.listSheets().map((info) => info.name)).toEqual(["Data"]);
    expect(valueAt(workbook, "Data", "A1")).toBe(1);
    expect(valueAt(workbook, "Data", "A4")).toBe(6);
  });
});

describe("proposed sheet edits", () => {
  it("records an added sheet and removes it on reject", () => {
    const { workbook } = smallBook();
    workbook.beginProposal(AGENT);
    const added = workbook.addSheet("Notes", 0);
    workbook.endProposal();
    const [change] = changes(workbook);
    expect(change).toMatchObject({ kind: "addSheet", sheet: added.id, newDisplay: "Notes", summary: "Add sheet Notes" });
    expect(workbook.getSheet(added.id).pendingChangeCount).toBe(1);
    workbook.rejectChanges([change!.id]);
    expect(workbook.getSheetByName("Notes")).toBeNull();
  });

  it("records a rename, updating formulas both ways", async () => {
    const workbook = await openXlsx(loadFixture("formulas.xlsx"));
    const calc = sheetId(workbook, "Calc");
    workbook.beginProposal(AGENT);
    workbook.renameSheet(calc, "Rates");
    workbook.renameSheet(calc, "Totals");
    workbook.endProposal();
    expect(at(workbook, "Data", "F2").formula).toBe("E2*(1+Totals!$B$6)");
    const list = changes(workbook);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "renameSheet", oldDisplay: "Calc", newDisplay: "Totals", summary: "Rename sheet Calc to Totals" });
    workbook.rejectChanges("all");
    expect(workbook.getSheet(calc).name).toBe("Calc");
    expect(at(workbook, "Data", "F2").formula).toBe("E2*(1+Calc!$B$6)");
  });

  it("drops a rename back to the old name and refuses removing a sheet inside a proposal", () => {
    const { workbook, sheet } = smallBook();
    const other = workbook.addSheet("Other");
    workbook.beginProposal(AGENT);
    workbook.renameSheet(sheet, "X");
    workbook.renameSheet(sheet, "Data");
    expect(changes(workbook)).toEqual([]);
    expect(codeOf(() => workbook.removeSheet(other.id))).toBe("invalid_operation");
    workbook.endProposal();
    workbook.removeSheet(other.id);
  });

  it("keeps old formulas of pending changes in step with later structural edits", async () => {
    const workbook = await openXlsx(loadFixture("formulas.xlsx"));
    const data = sheetId(workbook, "Data");
    const calc = sheetId(workbook, "Calc");
    workbook.beginProposal(AGENT);
    workbook.setFormula(data, a1("F2"), "E2*2");
    workbook.endProposal();
    // Outside the proposal: rows inserted on Calc move the rate cell.
    workbook.insertRows(calc, 0, 1);
    const [change] = changes(workbook);
    expect(change).toMatchObject({ oldFormula: "E2*(1+Calc!$B$7)", newFormula: "E2*2" });
    workbook.rejectChanges("all");
    workbook.recalc();
    expect(at(workbook, "Data", "F2")).toMatchObject({ formula: "E2*(1+Calc!$B$7)", value: 600 });
  });
});
