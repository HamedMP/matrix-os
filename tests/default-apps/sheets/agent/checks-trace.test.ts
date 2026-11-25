import { describe, expect, it } from "vitest";
import { createXlsx } from "../../../../home/apps/_shared/office-engine/index";
import { checkWorkbook, traceText, traceValue } from "../../../../home/apps/sheets/src/agent";
import { openModel } from "../review/fixture";

describe("deterministic checks", () => {
  it("finds the typed-in total revenue in the model and the projection total it disagrees with", async () => {
    const { session, sheets } = await openModel();
    const findings = checkWorkbook(session.workbook);
    const atB2 = findings.filter((finding) => finding.sheet === sheets.summary && finding.row === 1 && finding.col === 1);
    expect(atB2.map((finding) => finding.kind).sort()).toEqual(["hardcoded", "total-mismatch"]);
    const mismatch = atB2.find((finding) => finding.kind === "total-mismatch")!;
    expect(mismatch.location).toBe("Summary!B2");
    expect(mismatch.actual).toBe(725000);
    expect(mismatch.expected).toBeCloseTo(709601.48, 1);
    expect(mismatch.related).toEqual([{ sheet: sheets.projection, row: 3, col: 13 }]);
    expect(mismatch.message).toContain("Projection!N4");
    // Nothing else in the model is flagged: the inputs sheet and the month headers are not hard-coded numbers among formulas.
    expect(findings.filter((finding) => !(finding.sheet === sheets.summary && finding.row === 1 && finding.col === 1))).toEqual([]);
  });

  it("flags a SUM that leaves out a neighbouring number and a typed total that disagrees with the cells above", () => {
    const workbook = createXlsx();
    const sheet = workbook.listSheets()[0]!.id;
    workbook.setRange(sheet, { row: 0, col: 0 }, [["Item", "Q1", "Q2", "Q3", "Total"], ["Pens", 10, 20, 30, null], ["Paper", 5, 5, 5, null], ["Total", 15, 25, 99, null]]);
    workbook.setFormula(sheet, { row: 1, col: 4 }, "SUM(B2:C2)");
    workbook.setFormula(sheet, { row: 2, col: 4 }, "SUM(B3:D3)");
    workbook.recalc();
    const findings = checkWorkbook(workbook);
    const gap = findings.find((finding) => finding.kind === "sum-gap");
    expect(gap).toMatchObject({ location: "Sheet1!E2", row: 1, col: 4 });
    expect(gap!.message).toContain("D2");
    const typed = findings.filter((finding) => finding.kind === "total-mismatch");
    expect(typed.map((finding) => finding.location)).toEqual(["Sheet1!D4"]);
    expect(typed[0]!.expected).toBe(35);
    expect(typed[0]!.actual).toBe(99);
    // B4 and C4 add up: a typed total that agrees is still reported as typed in, not as a mismatch.
    expect(findings.some((finding) => finding.location === "Sheet1!B4" && finding.kind === "total-mismatch")).toBe(false);
  });

  it("returns nothing for an empty workbook", () => {
    expect(checkWorkbook(createXlsx())).toEqual([]);
  });
});

describe("tracing a value", () => {
  it("walks from the summary net income back to the typed-in assumptions", async () => {
    const { session, sheets } = await openModel();
    const trace = traceValue(session.workbook, sheets.summary, { row: 2, col: 1 });
    expect(trace.root).toMatchObject({ location: "Summary!B3", formula: "Projection!N10", kind: "formula" });
    expect(trace.root.children[0]).toMatchObject({ location: "Projection!N10", formula: "SUM(B10:M10)" });
    const inputs = trace.inputs.map((node) => node.location).sort();
    expect(inputs).toEqual(["Assumptions!B2", "Assumptions!B3", "Assumptions!B4", "Assumptions!B5", "Assumptions!B6"]);
    expect(trace.truncated).toBe(false);
    // Every cell visited can be highlighted on the grid.
    expect(trace.cells.some((cell) => cell.sheet === sheets.assumptions && cell.row === 1 && cell.col === 1)).toBe(true);
    const text = traceText(trace);
    expect(text.split("\n")[0]).toBe("Summary!B3 = Projection!N10 → 157,321");
    expect(text).toContain("Assumptions!B2: 50000 (typed-in input)");
  });

  it("stops at its node and depth bounds and says so", async () => {
    const { session, sheets } = await openModel();
    const trace = traceValue(session.workbook, sheets.summary, { row: 2, col: 1 }, { maxNodes: 10, maxDepth: 3 });
    expect(trace.nodeCount).toBeLessThanOrEqual(10);
    expect(trace.truncated).toBe(true);
  });

  it("describes a typed-in cell as an input with no sources", async () => {
    const { session, sheets } = await openModel();
    const trace = traceValue(session.workbook, sheets.summary, { row: 1, col: 1 });
    expect(trace.root).toMatchObject({ kind: "input", children: [] });
    expect(trace.inputs).toHaveLength(1);
  });
});
