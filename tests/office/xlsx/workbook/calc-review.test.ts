/**
 * Calculation after a file is opened and between bounded runs.
 *
 * Outcome protected: a workbook shows and saves the values its formulas
 * really have, whoever wrote the file. Faults detected: formulas without a
 * stored value never calculated, a cell named only for its position treated
 * as read, a formula that picks its cells at run time calculated too early,
 * a bound that stops the workbook for good, and a missing clock turning
 * dates into errors.
 */

import { describe, expect, it } from "vitest";
import { createXlsx, openXlsx, parseA1 } from "../../../../packages/office/src/xlsx/index.js";
import { buildXlsx, err, valueAt } from "./helpers.js";

const NOW = "2026-11-23T10:00:00Z";
const bare = (ref: string, formula: string): string => `<c r="${ref}"><f>${formula}</f></c>`;
const n = (ref: string, value: number): string => `<c r="${ref}"><v>${value}</v></c>`;

async function uncachedBook(): Promise<Uint8Array> {
  let rows = "";
  for (let r = 1; r <= 5; r++) {
    let extra = "";
    if (r === 1) extra = bare("E1", "SUM(C1:C5)");
    if (r === 2) extra = bare("E2", "E1*2");
    if (r === 4) extra = bare("E4", 'IF(E1&gt;10,"big","small")');
    rows += `<row r="${r}">${n(`A${r}`, r)}${n(`B${r}`, r * 10)}${bare(`C${r}`, `A${r}+B${r}`)}${extra}</row>`;
  }
  return buildXlsx({ sheets: [{ name: "S", rows }] });
}

describe("formulas without a stored value", () => {
  it("are calculated by the first run after opening", async () => {
    const workbook = await openXlsx(await uncachedBook());
    const sheet = workbook.listSheets()[0]!.id;
    workbook.recalc({ now: NOW });
    expect(["C1", "C5", "E1", "E2", "E4"].map((a) => valueAt(workbook, "S", a))).toEqual([11, 55, 165, 330, "big"]);
    workbook.setCell(sheet, parseA1("A1"), 100);
    workbook.recalc({ now: NOW });
    expect(["C1", "C2", "E1", "E2"].map((a) => valueAt(workbook, "S", a))).toEqual([110, 22, 264, 528]);
    const reopened = await openXlsx(await workbook.save());
    expect(valueAt(reopened, "S", "E1")).toBe(264);
  });

  it("are calculated by the save that follows an edit, when nobody asked for a run", async () => {
    const workbook = await openXlsx(await uncachedBook());
    workbook.setCell(workbook.listSheets()[0]!.id, parseA1("A1"), 100);
    const reopened = await openXlsx(await workbook.save());
    expect(["C1", "C3", "E1", "E4"].map((a) => valueAt(reopened, "S", a))).toEqual([110, 33, 264, "big"]);
  });

  it("leave a file that is opened and saved untouched as it was", async () => {
    const source = await uncachedBook();
    const workbook = await openXlsx(source);
    const reopened = await openXlsx(await workbook.save());
    expect(valueAt(reopened, "S", "E1")).toBeNull();
    expect(await reopened.package.getPartText("/xl/worksheets/sheet1.xml")).toBe(await (await openXlsx(source)).package.getPartText("/xl/worksheets/sheet1.xml"));
  });

  it("calculates everything when the workbook asks for a full calculation on load", async () => {
    const rows = `<row r="1">${n("A1", 2)}<c r="B1"><f>A1*3</f><v>999</v></c></row>`;
    const workbook = await openXlsx(await buildXlsx({ sheets: [{ name: "S", rows }], calcPr: ' fullCalcOnLoad="1"' }));
    workbook.recalc({ now: NOW });
    expect(valueAt(workbook, "S", "B1")).toBe(6);
    // Without the request a stored value is trusted.
    const trusted = await openXlsx(await buildXlsx({ sheets: [{ name: "S", rows }] }));
    trusted.recalc({ now: NOW });
    expect(valueAt(trusted, "S", "B1")).toBe(999);
  });
});

describe("a cell named for its position only", () => {
  it("is not read, so the formula is not circular", () => {
    const workbook = createXlsx({ sheetNames: ["S"] });
    const sheet = workbook.listSheets()[0]!.id;
    const set = (a: string, f: string): void => workbook.setFormula(sheet, parseA1(a), f);
    set("A1", "ROW(A1)");
    set("B1", "COLUMN(B1)");
    set("C1", "ROWS($C$1:C1)");
    set("D1", "COLUMNS($D$1:D1)");
    set("A2", "ROW()");
    set("B5", "VLOOKUP(1,$A$1:$C$2,COLUMN(B5),FALSE)");
    set("J1", "SUM(J2:J5)+ROW(J1)");
    set("E2", 'IF(ROW(E2)=2,"first","other")');
    const result = workbook.recalc({ now: NOW });
    expect(result.circular).toEqual([]);
    expect(["A1", "B1", "C1", "D1", "A2", "B5", "J1", "E2"].map((a) => valueAt(workbook, "S", a))).toEqual([1, 2, 1, 1, 2, 2, 1, "first"]);
  });

  it("keeps the stored values of such a file on a run without edits", async () => {
    const rows = `<row r="3"><c r="C3"><f>ROW(C3)</f><v>3</v></c><c r="D3"><f>C3*10</f><v>30</v></c></row>`;
    const workbook = await openXlsx(await buildXlsx({ sheets: [{ name: "S", rows }] }));
    const result = workbook.recalc({ now: NOW });
    expect(result.circular).toEqual([]);
    expect([valueAt(workbook, "S", "C3"), valueAt(workbook, "S", "D3")]).toEqual([3, 30]);
  });

  it("still reports a formula that reads its own cell", () => {
    const workbook = createXlsx({ sheetNames: ["S"] });
    const sheet = workbook.listSheets()[0]!.id;
    workbook.setFormula(sheet, parseA1("F1"), "F1+ROW(F1)");
    workbook.setFormula(sheet, parseA1("G1"), "SUM(G:G)");
    workbook.setFormula(sheet, parseA1("H1"), "ROW(H1:H3)+SUM(H1:H3)");
    const result = workbook.recalc({ now: NOW });
    expect(result.circular.map((cell) => cell.col).sort()).toEqual([5, 6, 7]);
    expect(valueAt(workbook, "S", "F1")).toEqual(err("#REF!"));
  });
});

describe("SUMIF and AVERAGEIF with a short sum range", () => {
  it("follow the cells the sum range is stretched over", async () => {
    const workbook = createXlsx({ sheetNames: ["S", "T"] });
    const sheet = workbook.listSheets()[0]!.id;
    const other = workbook.listSheets()[1]!.id;
    workbook.setRange(sheet, parseA1("A1"), [[1, 10], [1, 20], [1, 30]]);
    workbook.setFormula(sheet, parseA1("D1"), 'SUMIF(A1:A3,">0",B1)');
    workbook.setFormula(sheet, parseA1("D2"), 'AVERAGEIF(A1:A3,">0",(B1))');
    workbook.setFormula(sheet, parseA1("D3"), 'SUMIF(A1:A3,">0",T!B1:B2)');
    workbook.setRange(other, parseA1("B1"), [[1], [2], [3]]);
    workbook.recalc();
    expect([valueAt(workbook, "S", "D1"), valueAt(workbook, "S", "D2"), valueAt(workbook, "S", "D3")]).toEqual([60, 20, 6]);
    // Only cells outside the written sum range change.
    workbook.setCell(sheet, parseA1("B3"), 300);
    workbook.setCell(other, parseA1("B3"), 30);
    workbook.recalc();
    expect([valueAt(workbook, "S", "D1"), valueAt(workbook, "S", "D2"), valueAt(workbook, "S", "D3")]).toEqual([330, 110, 33]);
    expect(workbook.dependents(sheet, parseA1("B3")).map((cell) => cell.row)).toEqual([0, 1]);
    // The run save makes on its own covers them too.
    workbook.setCell(sheet, parseA1("B2"), 0);
    const reopened = await openXlsx(await workbook.save());
    expect(valueAt(reopened, "S", "D1")).toBe(310);
  });

  it("follow a sum range they cannot size before the run", () => {
    const workbook = createXlsx({ sheetNames: ["S"] });
    const sheet = workbook.listSheets()[0]!.id;
    workbook.setRange(sheet, parseA1("A1"), [[1, 10], [1, 20], [1, 30]]);
    workbook.setDefinedName({ name: "Start", scope: null, refersTo: "S!$B$1" });
    workbook.setFormula(sheet, parseA1("D1"), 'SUMIF(A1:A3,">0",Start)');
    workbook.recalc();
    expect(valueAt(workbook, "S", "D1")).toBe(60);
    workbook.setCell(sheet, parseA1("B3"), 300);
    workbook.recalc();
    expect(valueAt(workbook, "S", "D1")).toBe(330);
  });
});

describe("formulas that pick their cells at run time", () => {
  it("are calculated after the formula cells they read", async () => {
    const workbook = createXlsx({ sheetNames: ["S"] });
    const sheet = workbook.listSheets()[0]!.id;
    workbook.setFormula(sheet, parseA1("A1"), 'INDIRECT("B1")*2');
    workbook.setFormula(sheet, parseA1("B1"), "C1+1");
    workbook.setCell(sheet, parseA1("C1"), 1);
    workbook.recalc();
    expect(valueAt(workbook, "S", "A1")).toBe(4);
    workbook.setCell(sheet, parseA1("C1"), 10);
    workbook.recalc();
    expect([valueAt(workbook, "S", "B1"), valueAt(workbook, "S", "A1")]).toEqual([11, 22]);
    // The run save makes on its own covers them too.
    workbook.setCell(sheet, parseA1("C1"), 100);
    const reopened = await openXlsx(await workbook.save());
    expect([valueAt(reopened, "S", "B1"), valueAt(reopened, "S", "A1")]).toEqual([101, 202]);
  });

  it("follows OFFSET over formula cells", () => {
    const workbook = createXlsx({ sheetNames: ["S"] });
    const sheet = workbook.listSheets()[0]!.id;
    workbook.setFormula(sheet, parseA1("A1"), "SUM(OFFSET(B1,0,0,3,1))");
    workbook.setFormula(sheet, parseA1("B1"), "D1*2");
    workbook.setFormula(sheet, parseA1("B2"), "D1*3");
    workbook.setFormula(sheet, parseA1("B3"), "D1*4");
    workbook.setCell(sheet, parseA1("D1"), 1);
    workbook.recalc();
    expect(valueAt(workbook, "S", "A1")).toBe(9);
    workbook.setCell(sheet, parseA1("D1"), 10);
    workbook.recalc();
    expect(valueAt(workbook, "S", "A1")).toBe(90);
  });

  it("carries a late value on to the formulas that read the result", () => {
    const workbook = createXlsx({ sheetNames: ["S"] });
    const sheet = workbook.listSheets()[0]!.id;
    // E1 reads A1 by name, A1 reads B1 at run time, B1 reads a later formula cell.
    workbook.setFormula(sheet, parseA1("A1"), 'INDIRECT("B"&D1)+1');
    workbook.setFormula(sheet, parseA1("E1"), "A1*10");
    workbook.setFormula(sheet, parseA1("B1"), "C1+1");
    workbook.setFormula(sheet, parseA1("A3"), 'INDIRECT("E1")+INDIRECT("A1")');
    workbook.setCell(sheet, parseA1("C1"), 1);
    workbook.setCell(sheet, parseA1("D1"), 1);
    workbook.recalc();
    expect(["A1", "E1", "A3"].map((a) => valueAt(workbook, "S", a))).toEqual([3, 30, 33]);
    workbook.setCell(sheet, parseA1("C1"), 5);
    workbook.recalc();
    expect(["A1", "E1", "A3"].map((a) => valueAt(workbook, "S", a))).toEqual([7, 70, 77]);
  });

  it("reports a circle closed at run time instead of running on", () => {
    const workbook = createXlsx({ sheetNames: ["S"] });
    const sheet = workbook.listSheets()[0]!.id;
    workbook.setFormula(sheet, parseA1("A1"), 'INDIRECT("A2")+1');
    workbook.setFormula(sheet, parseA1("A2"), 'INDIRECT("A1")+1');
    workbook.setFormula(sheet, parseA1("C1"), 'INDIRECT("D1")+RAND()');
    workbook.setFormula(sheet, parseA1("C2"), 'INDIRECT("C1")+RAND()');
    workbook.setCell(sheet, parseA1("D1"), 5);
    const result = workbook.recalc();
    expect(result.complete).toBe(true);
    expect(result.circular.map((cell) => `${cell.row},${cell.col}`).sort()).toEqual(["0,0", "1,0"]);
    expect(valueAt(workbook, "S", "A1")).toEqual(err("#REF!"));
    const c1 = valueAt(workbook, "S", "C1") as number;
    const c2 = valueAt(workbook, "S", "C2") as number;
    expect(c1).toBeGreaterThanOrEqual(5);
    expect(c1).toBeLessThan(6);
    expect(c2).toBeGreaterThanOrEqual(c1);
    expect(c2).toBeLessThan(c1 + 1);
    // One entry per cell, from the value before the run to the value after it.
    const keys = result.changed.map((cell) => `${cell.row},${cell.col}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("the bounds of a run", () => {
  it("do not stop a long running balance", () => {
    const workbook = createXlsx({ sheetNames: ["S"] });
    const sheet = workbook.listSheets()[0]!.id;
    const rows = 10_500;
    workbook.setFormula(sheet, parseA1("B1"), `C${rows + 2}`);
    workbook.setCell(sheet, parseA1("C2"), 100);
    for (let i = 2; i < rows + 2; i++) {
      workbook.setCell(sheet, { row: i, col: 1 }, 1);
      workbook.setFormula(sheet, { row: i, col: 2 }, `C${i}+B${i + 1}`);
    }
    workbook.setFormula(sheet, parseA1("E1"), "1+1");
    const result = workbook.recalc();
    expect(result.complete).toBe(true);
    expect([valueAt(workbook, "S", "B1"), valueAt(workbook, "S", "E1")]).toEqual([100 + rows, 2]);
  });

  it("leave only the chain that is too deep for a later run", () => {
    const workbook = createXlsx({ sheetNames: ["S"] });
    const sheet = workbook.listSheets()[0]!.id;
    workbook.setCell(sheet, parseA1("A60"), 1);
    for (let row = 0; row < 59; row++) workbook.setFormula(sheet, { row, col: 0 }, `A${row + 2}+1`);
    workbook.setFormula(sheet, parseA1("E1"), "1+1");
    const shallow = workbook.recalc({ maxDepth: 10 });
    expect(shallow.complete).toBe(false);
    expect([valueAt(workbook, "S", "A1"), valueAt(workbook, "S", "E1")]).toEqual([null, 2]);
    const full = workbook.recalc();
    expect(full.complete).toBe(true);
    expect(valueAt(workbook, "S", "A1")).toBe(60);
  });

  it("continue where the last run stopped", async () => {
    const workbook = createXlsx({ sheetNames: ["S"] });
    const sheet = workbook.listSheets()[0]!.id;
    workbook.setCell(sheet, parseA1("A1"), 1);
    for (let i = 0; i < 50; i++) workbook.setFormula(sheet, { row: i, col: 1 }, `$A$1+${i}`);
    workbook.setFormula(sheet, parseA1("D1"), "RAND()");
    const done = (): number => {
      let count = 0;
      for (let i = 0; i < 50; i++) if (workbook.getCell(sheet, { row: i, col: 1 }).value !== null) count++;
      return count;
    };
    const seen: number[] = [];
    let last = workbook.recalc({ maxCells: 10 });
    seen.push(done());
    for (let k = 0; k < 5 && !last.complete; k++) {
      last = workbook.recalc({ maxCells: 10 });
      seen.push(done());
    }
    expect(last.complete).toBe(true);
    expect(seen[0]).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBe(50);
    // An edit between bounded runs is not lost, and what was calculated is not redone.
    workbook.setCell(sheet, parseA1("A1"), 2);
    const first = workbook.recalc({ maxCells: 20 });
    expect(first.complete).toBe(false);
    expect(first.changed.length).toBe(20);
    workbook.setCell(sheet, parseA1("F1"), 7);
    const second = workbook.recalc({ maxCells: 20 });
    expect(second.changed.length).toBe(20);
    // Save finishes what the bounded runs left.
    const reopened = await openXlsx(await workbook.save());
    for (let i = 0; i < 50; i++) expect(reopened.getCell(reopened.listSheets()[0]!.id, { row: i, col: 1 }).value).toBe(2 + i);
  });
});

describe("a run without a clock", () => {
  async function clockBook(): Promise<Uint8Array> {
    const workbook = createXlsx({ sheetNames: ["S"] });
    const sheet = workbook.listSheets()[0]!.id;
    workbook.setFormula(sheet, parseA1("A1"), "TODAY()");
    workbook.setFormula(sheet, parseA1("A2"), "A1+30");
    workbook.setFormula(sheet, parseA1("A3"), "YEAR(NOW())");
    workbook.setCell(sheet, parseA1("B1"), 1);
    workbook.setFormula(sheet, parseA1("B2"), "B1*2");
    workbook.recalc({ now: NOW });
    workbook.beginProposal({ author: "Agent", date: NOW, label: "x" });
    workbook.setCell(sheet, parseA1("B1"), 2);
    workbook.endProposal();
    return workbook.save();
  }

  it.each(["accept", "reject", "recalc", "insert"] as const)("keeps the stored dates through %s", async (mode) => {
    const workbook = await openXlsx(await clockBook());
    const sheet = workbook.listSheets()[0]!.id;
    if (mode === "accept") workbook.acceptChanges("all");
    if (mode === "reject") workbook.rejectChanges("all");
    if (mode === "recalc") workbook.recalc();
    if (mode === "insert") {
      workbook.acceptChanges("all");
      workbook.insertRows(sheet, 10, 1);
      workbook.recalc();
    }
    const reopened = await openXlsx(await workbook.save());
    expect(["A1", "A2", "A3"].map((a) => valueAt(reopened, "S", a))).toEqual([46349, 46379, 2026]);
    expect(valueAt(reopened, "S", "B2")).toBe(mode === "reject" ? 2 : 4);
  });

  it("shows an error for a date formula that was never calculated", () => {
    const workbook = createXlsx({ sheetNames: ["S"] });
    const sheet = workbook.listSheets()[0]!.id;
    workbook.setFormula(sheet, parseA1("A1"), "TODAY()");
    workbook.recalc();
    expect(valueAt(workbook, "S", "A1")).toEqual(err("#N/A"));
    workbook.recalc({ now: NOW });
    expect(valueAt(workbook, "S", "A1")).toBe(46349);
  });
});

describe("a chain of defined names", () => {
  // Outcome protected: a formula that reads a cell through many names follows that cell's edits.
  // Fault detected: the dependency graph stopping at a depth the evaluator still follows, so the result goes stale.
  it("keeps a formula up to date when the cell at the end of a deep chain changes", () => {
    const workbook = createXlsx({ sheetNames: ["S"] });
    const sheet = workbook.listSheets()[0]!.id;
    const depth = 12;
    for (let level = 1; level < depth; level++) workbook.setDefinedName({ name: `Step${level}`, scope: null, refersTo: `Step${level + 1}` });
    workbook.setDefinedName({ name: `Step${depth}`, scope: null, refersTo: "S!$A$1" });
    workbook.setCell(sheet, parseA1("A1"), 1);
    workbook.setFormula(sheet, parseA1("B1"), "Step1*10");
    workbook.recalc({ now: NOW });
    expect(valueAt(workbook, "S", "B1")).toBe(10);
    workbook.setCell(sheet, parseA1("A1"), 2);
    workbook.recalc({ now: NOW });
    expect(valueAt(workbook, "S", "B1")).toBe(20);
  });
});
