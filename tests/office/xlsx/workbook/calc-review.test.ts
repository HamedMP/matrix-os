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
import { TRACE_LIMIT } from "../../../../packages/office/src/xlsx/workbook/model.js";
import { stateOf } from "../../../../packages/office/src/xlsx/workbook/workbook.js";
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

describe("edits between runs", () => {
  it("are not held one by one past the trace limit, and every formula is calculated instead", () => {
    const workbook = createXlsx({ sheetNames: ["S"] });
    const sheet = workbook.listSheets()[0]!.id;
    workbook.setFormula(sheet, parseA1("B1"), "SUM(A1:A100000)");
    workbook.setFormula(sheet, parseA1("C1"), "B1*2");
    workbook.recalc();
    // Typing into a cell and clearing it again leaves the cell count where it was.
    for (let row = 0; row < 20_000; row++) {
      workbook.setCell(sheet, { row, col: 3 }, 1);
      workbook.setCell(sheet, { row, col: 3 }, null);
    }
    workbook.setCell(sheet, parseA1("A7"), 5);
    let held = 0;
    for (const edited of stateOf(workbook).calc.edited.values()) held += edited.size;
    expect(held).toBeLessThanOrEqual(TRACE_LIMIT + 1);
    workbook.recalc();
    expect([valueAt(workbook, "S", "B1"), valueAt(workbook, "S", "C1")]).toEqual([5, 10]);
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

  // Outcome protected: a date formula whose input changed is calculated again, however many cells were edited or
  // whatever else made the run calculate everything, while date formulas that read none of the edits keep their dates.
  // Fault detected: edits that are no longer held one by one (past the trace limit, after a sheet is added, across a
  // row insert) being invisible to the date formulas a run without a clock leaves alone.
  describe("after edits that are not held one by one", () => {
    async function inputBook(): Promise<Uint8Array> {
      const workbook = createXlsx({ sheetNames: ["S"] });
      const sheet = workbook.listSheets()[0]!.id;
      workbook.setCell(sheet, parseA1("A1"), 1);
      workbook.setFormula(sheet, parseA1("B1"), "IF(A1=1,TODAY(),42)");
      workbook.setCell(sheet, parseA1("F1"), 1);
      workbook.setFormula(sheet, parseA1("G1"), "IF(F1=1,TODAY(),42)");
      workbook.recalc({ now: NOW });
      return workbook.save();
    }

    function editMany(workbook: Awaited<ReturnType<typeof openXlsx>>, sheet: string): void {
      for (let row = 0; row <= TRACE_LIMIT + 100; row++) workbook.setCell(sheet, { row, col: 3 }, row);
    }

    it.each(["before", "after"] as const)("recalculates a date formula whose input was edited %s the trace limit tripped", async (when) => {
      const workbook = await openXlsx(await inputBook());
      const sheet = workbook.listSheets()[0]!.id;
      if (when === "before") workbook.setCell(sheet, parseA1("A1"), 2);
      editMany(workbook, sheet);
      if (when === "after") workbook.setCell(sheet, parseA1("A1"), 2);
      const reopened = await openXlsx(await workbook.save());
      expect([valueAt(reopened, "S", "B1"), valueAt(reopened, "S", "G1")]).toEqual([42, 46349]);
    });

    it("recalculates a date formula whose input was edited after a sheet was added", async () => {
      const workbook = await openXlsx(await inputBook());
      const sheet = workbook.listSheets()[0]!.id;
      workbook.addSheet("T");
      workbook.setCell(sheet, parseA1("A1"), 2);
      const reopened = await openXlsx(await workbook.save());
      expect([valueAt(reopened, "S", "B1"), valueAt(reopened, "S", "G1")]).toEqual([42, 46349]);
    });

    it.each(["a few", "many"] as const)("recalculates a date formula whose input was edited before rows moved, with %s edits", async (edits) => {
      const workbook = await openXlsx(await inputBook());
      const sheet = workbook.listSheets()[0]!.id;
      workbook.setCell(sheet, parseA1("A1"), 2);
      if (edits === "many") editMany(workbook, sheet);
      workbook.insertRows(sheet, 0, 1);
      const reopened = await openXlsx(await workbook.save());
      expect([valueAt(reopened, "S", "B2"), valueAt(reopened, "S", "G2")]).toEqual([42, 46349]);
    });

    // Fault detected: the date formulas kept from the last graph going stale while formulas are written past the trace
    // limit, so a date formula whose input changed is missed or one whose input did not is calculated.
    it("recalculates a date formula whose input was edited before many formulas were written", async () => {
      const workbook = await openXlsx(await inputBook());
      const sheet = workbook.listSheets()[0]!.id;
      // A run without a time builds the graph and keeps the dates.
      workbook.recalc();
      workbook.setCell(sheet, parseA1("A1"), 2);
      for (let row = 0; row <= TRACE_LIMIT; row++) workbook.setFormula(sheet, { row, col: 3 }, `${row}+1`);
      const reopened = await openXlsx(await workbook.save());
      expect([valueAt(reopened, "S", "B1"), valueAt(reopened, "S", "G1"), valueAt(reopened, "S", "D3")]).toEqual([42, 46349, 3]);
    });

    // Fault detected: edits past the trace limit kept only as a range around them, so a date formula reading an
    // untouched cell between the edits is taken as changed and loses its date.
    it("keeps the date of a formula whose input lies between edits past the trace limit", async () => {
      const source = createXlsx({ sheetNames: ["S"] });
      const id = source.listSheets()[0]!.id;
      source.setCell(id, parseA1("B1"), 1);
      source.setFormula(id, parseA1("D1"), "IF(B1=1,TODAY(),42)");
      source.recalc({ now: NOW });
      const workbook = await openXlsx(await source.save());
      const sheet = workbook.listSheets()[0]!.id;
      workbook.setCell(sheet, parseA1("A1"), 7);
      for (let row = 0; row < TRACE_LIMIT; row++) workbook.setCell(sheet, { row, col: 2 }, row);
      const reopened = await openXlsx(await workbook.save());
      expect(valueAt(reopened, "S", "D1")).toBe(46349);
    });

    // Fault detected: a rewrite of reference text (a sheet renamed, rows moved on another sheet) counted as an edit of
    // the formula, so a date formula whose inputs did not change is calculated without a time.
    async function crossBook(formula: string): Promise<Uint8Array> {
      const workbook = createXlsx({ sheetNames: ["S", "T"] });
      const [s, t] = workbook.listSheets().map((info) => info.id) as [string, string];
      workbook.setCell(s, parseA1("A1"), 1);
      workbook.setCell(s, parseA1("A5"), 1);
      workbook.setFormula(t, parseA1("B1"), formula);
      workbook.recalc({ now: NOW });
      return workbook.save();
    }

    it.each(["alone", "after a sheet is added"] as const)("keeps the date of a formula reading a sheet renamed %s", async (when) => {
      const workbook = await openXlsx(await crossBook("S!A1+TODAY()"));
      const s = workbook.listSheets()[0]!.id;
      if (when === "after a sheet is added") workbook.addSheet("U");
      workbook.renameSheet(s, "R");
      const reopened = await openXlsx(await workbook.save());
      expect(reopened.getCell(reopened.getSheetByName("T")!.id, parseA1("B1")).formula).toBe("R!A1+TODAY()");
      expect(valueAt(reopened, "T", "B1")).toBe(46350);
    });

    it("keeps the date of a formula on another sheet whose input moved with inserted rows", async () => {
      const workbook = await openXlsx(await crossBook("IF(S!A5=1,TODAY(),42)"));
      workbook.insertRows(workbook.listSheets()[0]!.id, 0, 2);
      const reopened = await openXlsx(await workbook.save());
      expect(valueAt(reopened, "T", "B1")).toBe(46349);
    });

    // Fault detected: a date formula that asks where a reference points (ROW, COLUMN, ROWS, COLUMNS) or reads cells by
    // position (OFFSET, INDIRECT) keeping its date when a move changes that answer, because those references are not
    // read as values; or one losing its date when the move leaves the answer as it was.
    type Move = "rows at the top" | "rows above A5" | "a row inside A1:A5" | "rows below" | "a column at the left";
    function move(workbook: Awaited<ReturnType<typeof openXlsx>>, how: Move): void {
      const s = workbook.listSheets()[0]!.id;
      if (how === "rows at the top") workbook.insertRows(s, 0, 2);
      if (how === "rows above A5") workbook.insertRows(s, 2, 2);
      if (how === "a row inside A1:A5") workbook.insertRows(s, 2, 1);
      if (how === "rows below") workbook.insertRows(s, 10, 1);
      if (how === "a column at the left") workbook.insertColumns(s, 0, 1);
    }

    it.each([
      ["IF(ROW(S!A5)=5,TODAY(),42)", "rows at the top", 42],
      ["IF(ROW(S!A5)=5,TODAY(),42)", "rows above A5", 42],
      ["IF(ROW(S!A5)=5,TODAY(),42)", "a column at the left", 46349],
      ["IF(ROW(S!A5)=5,TODAY(),42)", "rows below", 46349],
      ["IF(COLUMN(S!C1)=3,TODAY(),42)", "a column at the left", 42],
      ["IF(COLUMN(S!C1)=3,TODAY(),42)", "rows at the top", 46349],
      ["IF(ROWS(S!A1:A5)=5,TODAY(),42)", "a row inside A1:A5", 42],
      ["IF(ROWS(S!A1:A5)=5,TODAY(),42)", "rows at the top", 46349],
      ["IF(COLUMNS(S!A1:C1)=3,TODAY(),42)", "a column at the left", 46349],
      ["IF(OFFSET(S!A5,-4,0)=1,TODAY(),42)", "rows above A5", 42],
      ["IF(OFFSET(S!A5,-4,0)=1,TODAY(),42)", "rows at the top", 46349],
      ['IF(INDIRECT("S!A5")=1,TODAY(),42)', "rows at the top", 42],
      ['IF(INDIRECT("S!A5")=1,TODAY(),42)', "rows below", 46349],
      // Computed arguments are worked out before the move and judged like the written ones.
      ['IF(INDIRECT("S!A"&5)=1,TODAY(),42)', "rows at the top", 42],
      ['IF(INDIRECT("S!A"&5)=1,TODAY(),42)', "rows below", 46349],
      ['IF(INDIRECT("S!A"&S!A1*5,1=1)=1,TODAY(),42)', "rows below", 46349],
      ['IF(INDIRECT("S!A"&S!A1*5,1=1)=1,TODAY(),42)', "rows above A5", 42],
      ["IF(OFFSET(S!A5,S!A1-5,0)=1,TODAY(),42)", "rows above A5", 42],
      ["IF(OFFSET(S!A5,S!A1-5,0)=1,TODAY(),42)", "rows at the top", 46349],
      ["IF(SUM(OFFSET(S!A1,0,0,2+3,1))=2,TODAY(),42)", "a row inside A1:A5", 42],
      ["IF(SUM(OFFSET(S!A1,0,0,2+3,1))=2,TODAY(),42)", "rows below", 46349],
    ] as const)("gives %s after inserting %s the value it now has", async (formula, how, expected) => {
      const workbook = await openXlsx(await crossBook(formula));
      move(workbook, how);
      const reopened = await openXlsx(await workbook.save());
      expect(valueAt(reopened, "T", "B1")).toBe(expected);
    });

    // Fault detected: a freshly opened date formula whose INDIRECT address is computed counted as changed by any
    // move, because it has no record yet of the cells it read, so an unrelated row insert saved it as #N/A.
    it.each([
      ["below the used cells", 10, "B1", 46349],
      ["above the address it computes", 0, "B2", 42],
    ] as const)("judges the computed INDIRECT address of a freshly opened date formula after inserting a row %s", async (_, at, cell, expected) => {
      const source = createXlsx({ sheetNames: ["S"] });
      const id = source.listSheets()[0]!.id;
      source.setCell(id, parseA1("A1"), 1);
      source.setFormula(id, parseA1("B1"), 'IF(INDIRECT("A"&1)=1,TODAY(),42)');
      source.recalc({ now: NOW });
      const workbook = await openXlsx(await source.save());
      workbook.insertRows(workbook.listSheets()[0]!.id, at, 1);
      const reopened = await openXlsx(await workbook.save());
      expect(valueAt(reopened, "S", cell)).toBe(expected);
    });

    it("keeps the date of a formula asking where a reference points when its sheet is renamed", async () => {
      const workbook = await openXlsx(await crossBook("IF(ROW(S!A5)=5,TODAY(),42)"));
      workbook.renameSheet(workbook.listSheets()[0]!.id, "R");
      const reopened = await openXlsx(await workbook.save());
      expect(valueAt(reopened, "T", "B1")).toBe(46349);
    });

    it("recalculates a date formula on the moved sheet that asks where it or a reference is, and keeps one that reads a value", async () => {
      const source = createXlsx({ sheetNames: ["S"] });
      const id = source.listSheets()[0]!.id;
      source.setCell(id, parseA1("A5"), 1);
      source.setDefinedName({ name: "Spot", scope: null, refersTo: "S!$A$5" });
      source.setFormula(id, parseA1("B10"), "IF(ROW()=10,TODAY(),42)");
      source.setFormula(id, parseA1("C10"), "IF(ROW(A5)=5,TODAY(),42)");
      source.setFormula(id, parseA1("D10"), "IF(A5=1,TODAY(),42)");
      source.setFormula(id, parseA1("E10"), "IF(ROW(Spot)=5,TODAY(),42)");
      source.recalc({ now: NOW });
      const workbook = await openXlsx(await source.save());
      workbook.insertRows(workbook.listSheets()[0]!.id, 0, 1);
      const reopened = await openXlsx(await workbook.save());
      expect(["B11", "C11", "D11", "E11"].map((a) => valueAt(reopened, "S", a))).toEqual([42, 42, 46349, 42]);
    });

    // Fault detected: with rewrites no longer counted as edits, a date formula whose input was deleted keeping a date
    // its inputs no longer give.
    it.each(["deleted rows", "a removed sheet"] as const)("recalculates a date formula whose input went with %s", async (what) => {
      const workbook = await openXlsx(await crossBook("IF(S!A5=1,TODAY(),42)"));
      const s = workbook.listSheets()[0]!.id;
      if (what === "deleted rows") workbook.deleteRows(s, 4, 1);
      else workbook.removeSheet(s);
      const reopened = await openXlsx(await workbook.save());
      expect(valueAt(reopened, "T", "B1")).toEqual(err("#REF!"));
    });

    it("recalculates a date formula on the same sheet whose range lost rows, and keeps one whose input only moved", async () => {
      const source = createXlsx({ sheetNames: ["S"] });
      const id = source.listSheets()[0]!.id;
      source.setCell(id, parseA1("A1"), 1);
      source.setCell(id, parseA1("A2"), 1);
      source.setFormula(id, parseA1("B10"), "IF(SUM(A1:A3)=2,TODAY(),42)");
      source.setFormula(id, parseA1("C10"), "IF(A3=0,TODAY(),42)");
      source.recalc({ now: NOW });
      const workbook = await openXlsx(await source.save());
      workbook.deleteRows(workbook.listSheets()[0]!.id, 1, 1);
      const reopened = await openXlsx(await workbook.save());
      expect([valueAt(reopened, "S", "B9"), valueAt(reopened, "S", "C9")]).toEqual([42, 46349]);
    });

    // Fault detected: a defined name pointed at other cells leaving the date formulas that use it with dates their
    // inputs no longer give, or the change reaching date formulas that do not use the name.
    it.each(["set", "removed"] as const)("recalculates a date formula reading through a name that was %s", async (how) => {
      const source = createXlsx({ sheetNames: ["S"] });
      const id = source.listSheets()[0]!.id;
      source.setCell(id, parseA1("A1"), 1);
      source.setDefinedName({ name: "Val", scope: null, refersTo: "S!$A$1" });
      source.setDefinedName({ name: "Other", scope: null, refersTo: "S!$A$1" });
      source.setFormula(id, parseA1("B1"), "IF(Val=1,TODAY(),42)");
      source.setFormula(id, parseA1("C1"), "IF(A1=1,TODAY(),42)");
      source.recalc({ now: NOW });
      const workbook = await openXlsx(await source.save());
      if (how === "set") workbook.setDefinedName({ name: "Val", scope: null, refersTo: "S!$A$2" });
      else workbook.removeDefinedName("Val", null);
      workbook.setDefinedName({ name: "Other", scope: null, refersTo: "S!$A$3" });
      const reopened = await openXlsx(await workbook.save());
      expect([valueAt(reopened, "S", "B1"), valueAt(reopened, "S", "C1")]).toEqual([how === "set" ? 42 : err("#NAME?"), 46349]);
    });

    // Fault detected: a bounded run that stops before a date formula whose input changed leaving it pending, and the
    // next run without a time no longer knowing that its input changed.
    it("recalculates a date formula whose input changed after a bounded run stopped before it", async () => {
      const workbook = await openXlsx(await inputBook());
      const sheet = workbook.listSheets()[0]!.id;
      workbook.setCell(sheet, parseA1("A1"), 2);
      expect(workbook.recalc({ maxCells: 0 }).complete).toBe(false);
      const reopened = await openXlsx(await workbook.save());
      expect([valueAt(reopened, "S", "B1"), valueAt(reopened, "S", "G1")]).toEqual([42, 46349]);
    });
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
