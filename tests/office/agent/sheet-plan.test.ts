import { describe, expect, it } from "vitest";
import { applySheetEdits, parseAgentEdits, toSheetEdits } from "../../../packages/office/src/agent/index.js";
import type { Workbook } from "../../../packages/office/src/index.js";
import { createXlsx, isOfficeError, openXlsx, parseA1 } from "../../../packages/office/src/index.js";
import { AGENT, DATE, PROPOSAL, openXlsxFixture, sheetId } from "./helpers.js";

function cell(workbook: Workbook, sheet: string, a1: string) {
  return workbook.getCell(sheetId(workbook, sheet), parseA1(a1));
}

describe("toSheetEdits", () => {
  it("resolves sheets and addresses and tells literals from formulas", async () => {
    const workbook = await openXlsxFixture("model.xlsx");
    const plan = toSheetEdits(workbook, [
      { op: "setCell", sheet: "assumptions", cell: "B3", value: 0.05 },
      { op: "setCell", sheet: "Summary", cell: "$B$2", value: "=Projection!N4" },
      { op: "setCell", sheet: "Summary", cell: "C2", value: "Linked" },
      { op: "setCell", sheet: "Summary", cell: "C3", value: null },
    ]);
    expect(plan.rejected).toEqual([]);
    expect(plan.edits).toEqual([
      { editIndex: 0, sheet: sheetId(workbook, "Assumptions"), row: 2, col: 1, value: 0.05, formula: null },
      { editIndex: 1, sheet: sheetId(workbook, "Summary"), row: 1, col: 1, value: null, formula: "Projection!N4" },
      { editIndex: 2, sheet: sheetId(workbook, "Summary"), row: 1, col: 2, value: "Linked", formula: null },
      { editIndex: 3, sheet: sheetId(workbook, "Summary"), row: 2, col: 2, value: null, formula: null },
    ]);
    expect(workbook.listChanges()).toEqual([]);
    expect(cell(workbook, "Assumptions", "B3").value).toBe(0.03);
  });

  it("checks what the agent expected to find in the cell", async () => {
    const workbook = await openXlsxFixture("model.xlsx");
    const plan = toSheetEdits(workbook, [
      { op: "setCell", sheet: "Assumptions", cell: "B3", value: 0.05, expect: "3.0%" },
      { op: "setCell", sheet: "Summary", cell: "B3", value: 1, expect: "=Projection!N10" },
      { op: "setCell", sheet: "Summary", cell: "E9", value: 1, expect: "" },
      { op: "setCell", sheet: "Assumptions", cell: "B3", value: 0.05, expect: "0.03" },
      { op: "setCell", sheet: "Summary", cell: "B3", value: 1, expect: "157,321" },
      { op: "setCell", sheet: "Summary", cell: "E9", value: 1, expect: "something" },
    ]);
    expect(plan.edits.map((edit) => edit.editIndex)).toEqual([0, 1, 2]);
    expect(plan.rejected.map((entry) => [entry.index, entry.code])).toEqual([
      [3, "stale_reference"],
      [4, "stale_reference"],
      [5, "stale_reference"],
    ]);
  });

  it("rejects an unknown sheet, an address off the sheet and a formula that does not parse", async () => {
    const workbook = await openXlsxFixture("model.xlsx");
    const plan = toSheetEdits(workbook, [
      { op: "setCell", sheet: "Budget", cell: "A1", value: 1 },
      { op: "setCell", sheet: "Summary", cell: "XFE1", value: 1 },
      { op: "setCell", sheet: "Summary", cell: "A1", value: "=SUM(" },
      { op: "setCell", sheet: "Summary", cell: "A1", value: "=" },
      { op: "setRange", sheet: "Summary", start: "XFD1", values: [[1, 2]] },
      { op: "setRange", sheet: "Summary", start: "A1", values: [[1, "=1+"]] },
    ]);
    expect(plan.edits).toEqual([]);
    expect(plan.rejected.map((entry) => [entry.index, entry.code])).toEqual([
      [0, "not_found"],
      [1, "invalid_operation"],
      [2, "invalid_operation"],
      [3, "invalid_operation"],
      [4, "invalid_operation"],
      [5, "invalid_operation"],
    ]);
  });

  it("expands a setRange row by row and a clearRange over the used part of the sheet", async () => {
    const workbook = await openXlsxFixture("model.xlsx");
    const summary = sheetId(workbook, "Summary");
    const plan = toSheetEdits(workbook, [
      { op: "setRange", sheet: "Summary", start: "E1", values: [["Check", "=B2-Projection!N4"], [], [true]] },
      { op: "clearRange", sheet: "Summary", range: "C:C" },
      { op: "clearRange", sheet: "Summary", range: "Z50:AA60" },
    ]);
    expect(plan.rejected).toEqual([]);
    expect(plan.edits.filter((edit) => edit.editIndex === 0)).toEqual([
      { editIndex: 0, sheet: summary, row: 0, col: 4, value: "Check", formula: null },
      { editIndex: 0, sheet: summary, row: 0, col: 5, value: null, formula: "B2-Projection!N4" },
      { editIndex: 0, sheet: summary, row: 2, col: 4, value: true, formula: null },
    ]);
    expect(plan.edits.filter((edit) => edit.editIndex === 1).map((edit) => [edit.row, edit.col, edit.value, edit.formula])).toEqual([
      [0, 2, null, null],
      [1, 2, null, null],
      [2, 2, null, null],
      [3, 2, null, null],
      [4, 2, null, null],
    ]);
    expect(plan.edits.filter((edit) => edit.editIndex === 2)).toEqual([]);
  });

  it("rejects an edit to a cell that an array formula fills", async () => {
    const workbook = await openXlsxFixture("formulas.xlsx");
    const plan = toSheetEdits(workbook, [
      { op: "setCell", sheet: "Calc", cell: "D3", value: 1 },
      { op: "setCell", sheet: "Calc", cell: "D2", value: "=1+1" },
      { op: "setRange", sheet: "Calc", start: "C6", values: [["a", 1]] },
      { op: "clearRange", sheet: "Calc", range: "D2:D6" },
      { op: "setCell", sheet: "Calc", cell: "D7", value: 1 },
    ]);
    expect(plan.rejected.map((entry) => [entry.index, entry.code])).toEqual([
      [0, "invalid_operation"],
      [1, "invalid_operation"],
      [2, "invalid_operation"],
      [3, "invalid_operation"],
    ]);
    expect(plan.edits.map((edit) => edit.editIndex)).toEqual([4]);
    // What is left applies as a proposal without an error.
    expect(applySheetEdits(workbook, plan.edits, PROPOSAL).changeIds).toHaveLength(1);
  });

  it("rejects an edit to a cell that already has a pending change", async () => {
    const workbook = await openXlsxFixture("model.xlsx");
    const earlier = applySheetEdits(workbook, toSheetEdits(workbook, [{ op: "setCell", sheet: "Assumptions", cell: "B3", value: 0.05 }]).edits, PROPOSAL);
    const plan = toSheetEdits(workbook, [
      { op: "setCell", sheet: "Assumptions", cell: "B3", value: 0.07 },
      { op: "setRange", sheet: "Assumptions", start: "B2", values: [[1], [2]] },
      { op: "clearRange", sheet: "Assumptions", range: "B3:B4" },
      { op: "setCell", sheet: "Assumptions", cell: "B5", value: 20000 },
    ]);
    expect(plan.rejected.map((entry) => [entry.index, entry.code])).toEqual([
      [0, "invalid_operation"],
      [1, "invalid_operation"],
      [2, "invalid_operation"],
    ]);
    expect(plan.edits.map((edit) => edit.editIndex)).toEqual([3]);
    expect(workbook.listChanges().map((change) => [change.id, change.proposalId])).toEqual([[earlier.changeIds[0], earlier.proposalId]]);
  });

  it("refuses to clear more cells than one edit may touch", () => {
    const workbook = createXlsx();
    const id = workbook.listSheets()[0]?.id ?? "";
    workbook.setCell(id, { row: 0, col: 0 }, 1);
    workbook.setCell(id, { row: 200, col: 100 }, 1);
    const plan = toSheetEdits(workbook, [{ op: "clearRange", sheet: "Sheet1", range: "A:CW" }]);
    expect(plan.edits).toEqual([]);
    expect(plan.rejected.map((entry) => entry.code)).toEqual(["invalid_operation"]);
  });
});

describe("applySheetEdits", () => {
  it("records every edit as a pending change of one proposal and recalculates", async () => {
    const workbook = await openXlsxFixture("model.xlsx");
    const before = cell(workbook, "Summary", "B3").value as number;
    const plan = toSheetEdits(workbook, [
      { op: "setCell", sheet: "Assumptions", cell: "B3", value: 0.05, expect: "3.0%" },
      { op: "setCell", sheet: "Summary", cell: "B2", value: "=Projection!N4", expect: "725,000" },
    ]);
    const applied = applySheetEdits(workbook, plan.edits, PROPOSAL);
    expect(applied.changeIds).toHaveLength(2);
    expect(workbook.listProposals()).toEqual([{ id: applied.proposalId, ...PROPOSAL, pendingCount: 2 }]);
    const changes = workbook.listChanges();
    expect(changes.map((change) => [change.row, change.col, change.oldValue, change.oldFormula, change.newFormula, change.author, change.date])).toEqual([
      [2, 1, 0.03, null, null, AGENT, DATE],
      [1, 1, 725000, null, "Projection!N4", AGENT, DATE],
    ]);
    expect(changes[0]?.newValue).toBe(0.05);
    // Dependants were calculated: the projection grew, and the linked total shows it.
    expect(cell(workbook, "Summary", "B3").value as number).toBeGreaterThan(before);
    expect(cell(workbook, "Summary", "B2").value).toBeCloseTo(cell(workbook, "Projection", "N4").value as number, 6);
    expect(cell(workbook, "Assumptions", "B3").pendingChangeId).toBe(changes[0]?.id);
    // The proposal is closed: a later edit is direct.
    workbook.setCell(sheetId(workbook, "Summary"), parseA1("E1"), "note");
    expect(workbook.listChanges()).toHaveLength(2);
  });

  it("restores the old content of a rejected change and keeps an accepted one after save and reopen", async () => {
    const workbook = await openXlsxFixture("model.xlsx");
    const plan = toSheetEdits(workbook, [
      { op: "setCell", sheet: "Assumptions", cell: "B3", value: 0.05 },
      { op: "setCell", sheet: "Assumptions", cell: "B5", value: 20000 },
    ]);
    const applied = applySheetEdits(workbook, plan.edits, PROPOSAL);
    const growth = workbook.listChanges().find((change) => change.row === 2);
    const costs = workbook.listChanges().find((change) => change.row === 4);
    workbook.rejectChanges([growth?.id ?? ""]);
    workbook.recalc();
    expect(cell(workbook, "Assumptions", "B3").value).toBe(0.03);
    const reopened = await openXlsx(await workbook.save());
    expect(reopened.listChanges().map((change) => [change.id, change.proposalId, change.oldValue, change.newValue])).toEqual([[costs?.id, applied.proposalId, 18000, 20000]]);
    reopened.acceptChanges("all");
    expect(reopened.listChanges()).toEqual([]);
    expect(cell(reopened, "Assumptions", "B5").value).toBe(20000);
    expect(cell(reopened, "Summary", "B5").value).toBe(20000);
  });

  it("refuses to start while another proposal is open", async () => {
    const workbook = await openXlsxFixture("basic.xlsx");
    workbook.beginProposal(PROPOSAL);
    let code: string | null = null;
    try {
      applySheetEdits(workbook, [], PROPOSAL);
    } catch (error) {
      code = isOfficeError(error) ? error.code : "other";
    }
    expect(code).toBe("invalid_operation");
  });

  it("takes back what it recorded when an edit fails", async () => {
    const workbook = await openXlsxFixture("model.xlsx");
    const assumptions = sheetId(workbook, "Assumptions");
    let code: string | null = null;
    try {
      applySheetEdits(
        workbook,
        [
          { editIndex: 0, sheet: assumptions, row: 2, col: 1, value: 0.07, formula: null },
          { editIndex: 1, sheet: "no-such-sheet", row: 0, col: 0, value: 1, formula: null },
        ],
        PROPOSAL,
      );
    } catch (error) {
      code = isOfficeError(error) ? error.code : "other";
    }
    expect(code).toBe("not_found");
    expect(workbook.listChanges()).toEqual([]);
    expect(cell(workbook, "Assumptions", "B3").value).toBe(0.03);
    // No proposal was left open.
    expect(typeof workbook.beginProposal(PROPOSAL)).toBe("string");
  });

  it("refuses, before writing anything, edits to a cell that another proposal changed", async () => {
    const workbook = await openXlsxFixture("model.xlsx");
    const assumptions = sheetId(workbook, "Assumptions");
    const earlier = applySheetEdits(workbook, [{ editIndex: 0, sheet: assumptions, row: 2, col: 1, value: 0.05, formula: null }], PROPOSAL);
    let code: string | null = null;
    try {
      applySheetEdits(
        workbook,
        [
          { editIndex: 0, sheet: assumptions, row: 4, col: 1, value: 20000, formula: null },
          { editIndex: 1, sheet: assumptions, row: 2, col: 1, value: 0.07, formula: null },
          { editIndex: 2, sheet: "no-such-sheet", row: 0, col: 0, value: 1, formula: null },
        ],
        PROPOSAL,
      );
    } catch (error) {
      code = isOfficeError(error) ? error.code : "other";
    }
    expect(code).toBe("invalid_operation");
    // The earlier proposal keeps its change exactly; nothing of the refused one was written.
    expect(workbook.listChanges().map((change) => [change.id, change.proposalId, change.oldValue, change.newValue])).toEqual([
      [earlier.changeIds[0], earlier.proposalId, 0.03, 0.05],
    ]);
    expect(cell(workbook, "Assumptions", "B3").value).toBe(0.05);
    expect(cell(workbook, "Assumptions", "B5").value).toBe(18000);
    expect(workbook.listProposals().map((proposal) => proposal.id)).toEqual([earlier.proposalId]);
    expect(typeof workbook.beginProposal(PROPOSAL)).toBe("string");
  });

  it("runs from an agent answer to recorded changes", async () => {
    const workbook = await openXlsxFixture("formulas.xlsx");
    const answer = JSON.stringify({ kind: "sheet", edits: [{ op: "setRange", sheet: "Data", start: "H1", values: [["Checked", true]] }] });
    const parsed = parseAgentEdits(answer, "sheet");
    if (!parsed.ok || parsed.envelope.kind !== "sheet") throw new Error("the answer did not parse");
    const applied = applySheetEdits(workbook, toSheetEdits(workbook, parsed.envelope.edits).edits, PROPOSAL);
    expect(applied.changeIds).toHaveLength(2);
    expect(cell(workbook, "Data", "H1").value).toBe("Checked");
    expect(cell(workbook, "Data", "I1").value).toBe(true);
  });
});
