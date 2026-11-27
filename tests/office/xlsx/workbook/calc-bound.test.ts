/**
 * Calculations split by a bound on the cells a run may calculate.
 *
 * Outcome protected: a caller that calculates a workbook a few cells at a
 * time, until a run reports itself complete, ends with the values one whole
 * run gives. Faults detected: a bound that leaves a formula neither
 * calculated nor pending, so later runs never finish, and runs of one cell
 * reaching values or circles a whole run does not.
 */

import { describe, expect, it } from "vitest";
import { createXlsx, parseA1 } from "../../../../packages/office/src/xlsx/index.js";
import { valueAt } from "./helpers.js";

type Book = ReturnType<typeof createXlsx>;

function cellsOf(list: readonly { row: number; col: number }[]): string[] {
  return list.map((cell) => `${cell.row},${cell.col}`).sort();
}

/** Calls `recalc({ maxCells: 1 })` until a run is complete, at most `limit` times. */
function recalcByOne(workbook: Book, limit: number): { complete: boolean; circular: string[] } {
  const circular: string[] = [];
  let complete = false;
  for (let i = 0; i < limit && !complete; i++) {
    const result = workbook.recalc({ maxCells: 1 });
    circular.push(...cellsOf(result.circular));
    complete = result.complete;
  }
  return { complete, circular: circular.sort() };
}

function build(formulas: ReadonlyArray<readonly [string, string]>): { workbook: Book; sheet: string } {
  const workbook = createXlsx({ sheetNames: ["S"] });
  const sheet = workbook.listSheets()[0]!.id;
  for (const [ref, formula] of formulas) workbook.setFormula(sheet, parseA1(ref), formula);
  return { workbook, sheet };
}

describe("a bounded calculation", () => {
  // Fault detected: the bound stopped a run while it calculated a formula without reads to look for circles
  // closed at run time; that formula was not left pending, so every later run spent its one cell on A1 again
  // and returned incomplete for good.
  it("finishes when the bound stops the look for circles closed at run time", () => {
    const { workbook, sheet } = build([
      ["D1", "1"],
      ["A1", 'INDIRECT("B1")'],
      ["B1", "IF(TRUE,7,A1)"],
    ]);
    expect(workbook.recalc().complete).toBe(true);
    workbook.setFormula(sheet, parseA1("D1"), "2");
    const { complete, circular } = recalcByOne(workbook, 20);
    expect(complete).toBe(true);
    expect(circular).toEqual([]);
    expect(["A1", "B1", "D1"].map((a) => valueAt(workbook, "S", a))).toEqual([7, 7, 2]);
  });

  const books: ReadonlyArray<ReadonlyArray<readonly [string, string]>> = [
    [
      ["D1", "1"],
      ["A1", 'INDIRECT("B1")'],
      ["B1", "IF(TRUE,7,A1)"],
    ],
    [
      ["D1", "3"],
      ["A1", "OFFSET(A1,1,0)+D1"],
      ["A2", 'IF(D1>2,INDIRECT("C1"),A1)'],
      ["C1", "D1*2"],
      ["E1", "A1+A2"],
    ],
    [
      ["D1", "2"],
      ["A1", 'INDIRECT("B"&D1)'],
      ["B1", "IF(FALSE,A1,5)"],
      ["B2", "OFFSET(B1,0,0)+1"],
      ["C1", 'IF(A1>3,INDIRECT("B1"),B2)'],
    ],
    [
      ["D1", "1"],
      ["A1", 'IF(D1=1,INDIRECT("A2"),INDIRECT("A3"))'],
      ["A2", "OFFSET(D1,0,0)*10"],
      ["A3", "IF(TRUE,1,A1)"],
      ["A4", "SUM(A1:A3)"],
    ],
    [
      ["D1", "1"],
      ["A1", 'INDIRECT("B1")'],
      ["B1", 'IF(D1>3,INDIRECT("A1"),1)'],
    ],
    // A circle closed at run time whose values agree, split by the bound across runs.
    [
      ["D1", "1"],
      ["A2", "OFFSET(B1,0,0)"],
      ["B1", "IF(D1>2,A2,6)"],
    ],
    [
      ["D1", "1"],
      ["A1", 'IF(D1>2,INDIRECT("C1"),D1)'],
      ["C1", "IF(D1>2,A1,5)"],
    ],
  ];

  it.each(books.map((formulas) => [formulas.map(([ref, f]) => `${ref}=${f}`).join("; "), formulas] as const))(
    "reaches in runs of one cell what one run gives: %s",
    (_label, formulas) => {
      const whole = build(formulas);
      const split = build(formulas);
      expect(whole.workbook.recalc().complete).toBe(true);
      expect(split.workbook.recalc().complete).toBe(true);
      whole.workbook.setFormula(whole.sheet, parseA1("D1"), "4");
      split.workbook.setFormula(split.sheet, parseA1("D1"), "4");
      const expected = whole.workbook.recalc();
      expect(expected.complete).toBe(true);
      // Each run calculates at least one cell, so a handful of rounds per formula is ample.
      const { complete, circular } = recalcByOne(split.workbook, 50 * formulas.length);
      expect(complete).toBe(true);
      expect(circular).toEqual(cellsOf(expected.circular));
      for (const [ref] of formulas) expect(valueAt(split.workbook, "S", ref), ref).toEqual(valueAt(whole.workbook, "S", ref));
    },
  );
});
