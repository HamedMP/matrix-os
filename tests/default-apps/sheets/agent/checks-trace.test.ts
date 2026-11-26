import { describe, expect, it } from "vitest";
import { createXlsx } from "../../../../home/apps/_shared/office-engine/index";
import { MAX_FINDINGS, checkWorkbook, directPrecedents, traceText, traceValue } from "../../../../home/apps/sheets/src/agent";
import type { Workbook } from "../../../../home/apps/_shared/office-engine/index";
import { openModel } from "../review/fixture";

/**
 * A one-sheet workbook of `rows` by `cols` cells from `make`, counting how
 * often the checks read a cell of the sheet.
 */
function countingWorkbook(rows: number, cols: number, make: (row: number, col: number) => { value: number | string | null; formula: string | null }): { workbook: Workbook; reads: () => number } {
  let reads = 0;
  const grid = Array.from({ length: rows }, (_, row) => {
    const cells = Array.from({ length: cols }, (_, col) => ({ ...make(row, col), styleId: 0, display: "", formulaUnsupported: false, arrayRange: null }));
    return new Proxy(cells, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
  });
  const dimensions = { start: { row: 0, col: 0 }, end: { row: rows - 1, col: cols - 1 } };
  const workbook = {
    listSheets: () => [{ id: "s1", name: "Sheet1" }],
    getSheet: () => ({ id: "s1", name: "Sheet1", dimensions }),
    getRange: () => grid,
    getStyle: () => createXlsx().getStyle(0),
  } as unknown as Workbook;
  return { workbook, reads: () => reads };
}

describe("deterministic checks", () => {
  it("finds the typed-in total revenue in the model and the projection total it disagrees with", async () => {
    const { session, sheets } = await openModel();
    const { findings } = checkWorkbook(session.workbook);
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
    const { findings } = checkWorkbook(workbook);
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

  // Outcome: Check finishes promptly on a large sheet of formulas.
  // Fault: every formula cell searches its whole column for a header (and its whole row for a label)
  // from scratch, so a long column of numeric formulas without text costs billions of cell reads.
  it("reads each cell a bounded number of times, however long its column or row", () => {
    for (const [rows, cols] of [
      [4000, 1],
      [1, 4000],
    ] as const) {
      const { workbook, reads } = countingWorkbook(rows, cols, (row, col) => ({ value: row + col + 1, formula: "1+1" }));
      expect(checkWorkbook(workbook).findings).toEqual([]);
      expect(reads()).toBeLessThan(rows * cols * 40);
    }
  });

  it("names the numbers a column SUM leaves out on both sides of its range, but not dates", () => {
    const workbook = createXlsx();
    const sheet = workbook.listSheets()[0]!.id;
    // A1 "Amount", A2..A4 numbers, A5..A6 summed, A7 a date, A8..A13 numbers, A14 = SUM(A5:A6).
    workbook.setRange(sheet, { row: 0, col: 0 }, [["Amount"], [1], [2], [3], [4], [5], [46388], [6], [7], [8], [9], [10], [11]]);
    workbook.setStyle(sheet, { start: { row: 6, col: 0 }, end: { row: 6, col: 0 } }, { numberFormat: "mmm yyyy" });
    workbook.setFormula(sheet, { row: 13, col: 0 }, "SUM(A5:A6)");
    workbook.recalc();
    const gap = checkWorkbook(workbook).findings.find((finding) => finding.kind === "sum-gap");
    expect(gap?.message).toBe("Sheet1!A14 adds up A5:A6 but leaves out A8, A9, A10, A11, A12 and more.");

    const short = createXlsx();
    const only = short.listSheets()[0]!.id;
    short.setRange(only, { row: 0, col: 0 }, [["Amount"], [1], [2], [3], [4], [null], [5]]);
    short.setFormula(only, { row: 7, col: 0 }, "SUM(A3:A4)");
    short.recalc();
    // A2 is right before the range; A5 and A7 are between the range and the total (A6 is empty).
    expect(checkWorkbook(short).findings.find((finding) => finding.kind === "sum-gap")?.message).toBe("Sheet1!A8 adds up A3:A4 but leaves out A5, A7, A2.");
  });

  it("reads each cell a bounded number of times for a column of SUMs over error values", () => {
    // Every cell is a SUM of the one above that yields an error, so no SUM finds a number it left out.
    const { workbook, reads } = countingWorkbook(4000, 1, (row) => ({ value: { code: "#DIV/0!" } as never, formula: row === 0 ? "1/0" : `SUM(A${row}:A${row})` }));
    expect(checkWorkbook(workbook).findings).toEqual([]);
    expect(reads()).toBeLessThan(4000 * 40);
  });

  it("returns nothing for an empty workbook", () => {
    expect(checkWorkbook(createXlsx())).toEqual({ findings: [], skipped: [], capped: false });
  });

  // Outcome: a check that could not read a sheet says so. Fault: a sparse sheet whose used area is past
  // the scan bound is left out silently and the run reads as an all-clear.
  it("names the sheets too large to check instead of passing them", () => {
    const workbook = createXlsx();
    const first = workbook.listSheets()[0]!.id;
    workbook.setCell(first, { row: 0, col: 0 }, 1);
    workbook.setCell(first, { row: 999, col: 299 }, 2);
    const small = workbook.addSheet("Small").id;
    workbook.setCell(small, { row: 0, col: 0 }, 3);
    workbook.addSheet("Empty");
    workbook.recalc();
    expect(checkWorkbook(workbook)).toEqual({ findings: [], skipped: [{ sheet: first, name: "Sheet1" }], capped: false });
    expect(checkWorkbook(workbook, { sheets: [small] }).skipped).toEqual([]);
  });

  it("says when it stopped at the most findings it reports", () => {
    // One cell in ten, never two in a line within reach of each other, is a typed-in number among formulas.
    const make = (row: number, col: number) => ((row * 7 + col) % 10 === 0 ? { value: 5, formula: null } : { value: 5, formula: "2+3" });
    const report = checkWorkbook(countingWorkbook(60, 60, make).workbook);
    expect(report.findings).toHaveLength(MAX_FINDINGS);
    expect(report.capped).toBe(true);
    const few = checkWorkbook(countingWorkbook(10, 10, make).workbook);
    expect(few.findings.length).toBeGreaterThan(0);
    expect(few.capped).toBe(false);
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

  describe("over a formula that covers a large, mostly empty area", () => {
    // Two values far apart make the used area of the sheet large; the formula reads all of it.
    function sparse(): { workbook: Workbook; sheet: string; reads: () => number } {
      const workbook = createXlsx();
      const sheet = workbook.listSheets()[0]!.id;
      workbook.setCell(sheet, { row: 0, col: 0 }, 1);
      workbook.setCell(sheet, { row: 199_999, col: 49 }, 2);
      workbook.setFormula(sheet, { row: 0, col: 60 }, "SUM(A1:AX200000)");
      workbook.recalc();
      let count = 0;
      const getCell = workbook.getCell.bind(workbook);
      const precedents = workbook.precedents.bind(workbook);
      workbook.getCell = (...args) => {
        count += 1;
        return getCell(...args);
      };
      workbook.precedents = (...args) => {
        count += 1;
        return precedents(...args);
      };
      return { workbook, sheet, reads: () => count };
    }

    it("reads a bounded number of positions and says the range was not read to the end", () => {
      const { workbook, sheet, reads } = sparse();
      const trace = traceValue(workbook, sheet, { row: 0, col: 60 }, { maxScanCells: 5_000 });
      expect(reads()).toBeLessThan(6_000);
      expect(trace.truncated).toBe(true);
      const range = trace.root.children[0]!;
      expect(range).toMatchObject({ kind: "range", unscanned: true });
      expect(range.children.map((child) => child.location)).toEqual(["Sheet1!A1"]);
      expect(traceText(trace)).toContain("not read to the end");
    });

    it("finds the highlighted sources of a selection within the same bound", () => {
      const { workbook, sheet, reads } = sparse();
      // The selection holds no formula: every position in it is looked at and none reads anything.
      expect(directPrecedents(workbook, sheet, { start: { row: 0, col: 0 }, end: { row: 199_999, col: 49 } }, 5_000)).toEqual([]);
      expect(reads()).toBeLessThanOrEqual(5_001);
    });
  });
});
