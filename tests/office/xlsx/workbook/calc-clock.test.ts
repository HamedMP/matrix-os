/**
 * A run without a clock (no `now` supplied in the session yet).
 *
 * Outcome protected: a formula that needs the time keeps the date it was
 * saved with exactly when its answer still depends on the time, and shows
 * its new answer when it no longer does. Fault detected: a date formula
 * saved as `#N/A`, or keeping a date its inputs no longer give, after an
 * edit, a move, a sheet or name change, or a bounded run.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Workbook } from "../../../../packages/office/src/api/xlsx.js";
import { createXlsx, openXlsx, parseA1 } from "../../../../packages/office/src/xlsx/index.js";
import { needsRecalc } from "../../../../packages/office/src/xlsx/workbook/calc.js";
import { TRACE_LIMIT } from "../../../../packages/office/src/xlsx/workbook/model.js";
import { stateOf } from "../../../../packages/office/src/xlsx/workbook/workbook.js";
import { buildXlsx, err, fx, num, valueAt } from "./helpers.js";

const NOW = "2026-11-23T10:00:00Z";
/** Enough cells in an OFFSET argument that working the argument out on its own would be costly. */
const MANY_CELLS = 100_000;

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

    // Fault detected: a rewrite of reference text (a sheet renamed, rows moved on another sheet) making a date formula
    // whose inputs did not change lose its date.
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
      // Arguments are converted as OFFSET converts them: "-400%" is -4, and text that is no number makes it #VALUE!.
      ['IF(OFFSET(S!A5,"-400%",0)=1,TODAY(),42)', "rows above A5", 42],
      ['IF(OFFSET(S!A5,"-400%",0)=1,TODAY(),42)', "rows at the top", 46349],
      ['IF(ISERROR(OFFSET(S!A5,"four",0)),TODAY(),42)', "rows above A5", 46349],
      ["IF(ISERROR(OFFSET(S!A5,#N/A,0)),TODAY(),42)", "rows above A5", 46349],
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

    // Fault detected: an OFFSET whose offset sums many cells counted as unchanged for a freshly opened formula, so it
    // kept a date the moved formula no longer gives.
    it.each([
      ["above the base", 2, 42],
      ["below the base", 10, 46349],
    ] as const)("judges a freshly opened date formula whose OFFSET sums many cells after inserting rows %s", async (_, at, expected) => {
      const source = createXlsx({ sheetNames: ["S", "T", "U"] });
      const [s, t, u] = source.listSheets().map((info) => info.id) as [string, string, string];
      source.setCell(s, parseA1("A1"), 1);
      source.setCell(s, parseA1("A5"), 1);
      source.setCell(u, parseA1("A1"), -4);
      source.setCell(u, { row: MANY_CELLS, col: 0 }, 0);
      source.setFormula(t, parseA1("B1"), `IF(OFFSET(S!A5,SUM(U!A1:A${MANY_CELLS + 1}),0)=1,TODAY(),42)`);
      source.recalc({ now: NOW });
      const workbook = await openXlsx(await source.save());
      workbook.insertRows(workbook.listSheets()[0]!.id, at, 2);
      const reopened = await openXlsx(await workbook.save());
      expect(valueAt(reopened, "T", "B1")).toEqual(expected);
    });

    // Fault detected: INDIRECT of a defined name taken as following the move whatever the name holds, so a date formula
    // kept its date when the name picks its cells by position.
    it.each([
      ["rows above A5", 42],
      ["rows at the top", 46349],
    ] as const)("judges the name INDIRECT reads by what it holds after inserting %s", async (how, expected) => {
      const source = createXlsx({ sheetNames: ["S", "T"] });
      const [s, t] = source.listSheets().map((info) => info.id) as [string, string];
      source.setCell(s, parseA1("A1"), 1);
      source.setCell(s, parseA1("A5"), 1);
      source.setDefinedName({ name: "Picked", refersTo: "OFFSET(S!$A$5,-4,0)", scope: null });
      source.setFormula(t, parseA1("B1"), 'IF(INDIRECT("Picked")=1,TODAY(),42)');
      source.recalc({ now: NOW });
      const workbook = await openXlsx(await source.save());
      move(workbook, how);
      const reopened = await openXlsx(await workbook.save());
      expect(valueAt(reopened, "T", "B1")).toBe(expected);
    });

    // Fault detected: a position that moved inside an OFFSET or INDIRECT argument, or inside the name INDIRECT reads,
    // counted as a change of the call even when the call gives the same answer after the move (the same error, or the
    // cells it read moved along), so a date formula whose answer stays was saved as #N/A.
    it.each([
      // The name gives a number before and after, which INDIRECT answers with #REF! both times.
      ["ROW(S!A5)", 'IF(ISERROR(INDIRECT("Picked")),TODAY(),42)', 46349],
      // The error the name gives changes kind, #DIV/0! to #REF!.
      ["1/(ROW(S!A5)-5)", 'IF(ERROR.TYPE(INDIRECT("Picked"))=2,TODAY(),42)', 42],
      // The name gives a reference after the move.
      ["CHOOSE(ROW(S!A5)-4,3,3,S!A1)", 'IF(ISERROR(INDIRECT("Picked")),TODAY(),42)', 42],
    ] as const)("judges INDIRECT of a name holding %s by what INDIRECT gives after inserting rows above A5", async (refersTo, formula, expected) => {
      const source = createXlsx({ sheetNames: ["S", "T"] });
      const [s, t] = source.listSheets().map((info) => info.id) as [string, string];
      source.setCell(s, parseA1("A1"), 1);
      source.setCell(s, parseA1("A5"), 1);
      source.setDefinedName({ name: "Picked", refersTo, scope: null });
      source.setFormula(t, parseA1("B1"), formula);
      source.recalc({ now: NOW });
      const workbook = await openXlsx(await source.save());
      move(workbook, "rows above A5");
      const reopened = await openXlsx(await workbook.save());
      expect(valueAt(reopened, "T", "B1")).toBe(expected);
    });

    it.each([
      // The same error before and after.
      ['IF(ISERROR(OFFSET(S!A5,"x"&ROW(S!A5),0)),TODAY(),42)', 46349],
      ['IF(ISERROR(INDIRECT("#"&ROW(S!A5))),TODAY(),42)', 46349],
      // The address moves along with the cell it names.
      ['IF(INDIRECT("S!A"&ROW(S!A5))=1,TODAY(),42)', 46349],
      ["IF(OFFSET(S!A1,ROW(S!A5)-5,0)=1,TODAY(),42)", 42],
      // The address now names an inserted row.
      ['IF(INDIRECT("S!A"&(ROW(S!A5)-4))=1,TODAY(),42)', 42],
    ] as const)("judges %s by what the call gives after inserting rows above A5", async (formula, expected) => {
      const workbook = await openXlsx(await crossBook(formula));
      move(workbook, "rows above A5");
      const reopened = await openXlsx(await workbook.save());
      expect(valueAt(reopened, "T", "B1")).toBe(expected);
    });

    // Fault guarded: the call is judged by values that move along unchanged, which a formula it reads need not keep:
    // here the cell INDIRECT reads asks for its own row, so the move changes what INDIRECT gives.
    it("calculates again a date formula whose INDIRECT reads a formula the move changes", async () => {
      const source = createXlsx({ sheetNames: ["S", "T"] });
      const [s, t] = source.listSheets().map((info) => info.id) as [string, string];
      source.setFormula(s, parseA1("A5"), "ROW()");
      source.setFormula(t, parseA1("B1"), 'IF(INDIRECT("S!A"&ROW(S!A5))=5,TODAY(),42)');
      source.recalc({ now: NOW });
      const workbook = await openXlsx(await source.save());
      move(workbook, "rows above A5");
      const reopened = await openXlsx(await workbook.save());
      expect(valueAt(reopened, "T", "B1")).toBe(42);
    });

    // Fault guarded: an address INDIRECT reads inside an OFFSET argument is not rewritten, so after deleting a row it
    // reads other cells, and the sum moves OFFSET onto a cell that was not its target before.
    it("calculates again a date formula whose OFFSET argument reads other cells by address after deleting a row", async () => {
      const source = createXlsx({ sheetNames: ["S", "T"] });
      const [s, t] = source.listSheets().map((info) => info.id) as [string, string];
      source.setCell(s, parseA1("A4"), 1);
      source.setCell(s, parseA1("C4"), 1);
      source.setFormula(t, parseA1("B1"), 'IF(OFFSET(S!A5,SUM(INDIRECT("S!C1:C3"))-1,0)=1,TODAY(),42)');
      source.recalc({ now: NOW });
      const workbook = await openXlsx(await source.save());
      workbook.deleteRows(workbook.listSheets()[0]!.id, 1, 1);
      const reopened = await openXlsx(await workbook.save());
      expect(valueAt(reopened, "T", "B1")).toBe(42);
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

    // Fault detected: a date formula whose input was deleted keeping a date its inputs no longer give.
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

  // Outcome protected: a bounded calculation without a time finishes. A formula that picks its cells at run time
  // and keeps its date is not calculated again by the runs that take up the rest of the same calculation, and is
  // calculated again once the workbook is edited or a time is given. Fault detected: such a formula counted as never
  // calculated after every run, so it takes the whole budget of each resumed run and the formulas after it stay
  // pending for ever.
  describe("in a bounded calculation, a formula that picks its cells at run time and keeps its date", () => {
    const KEPT = 'IF(TRUE,TODAY(),INDIRECT("A1"))';

    it("is not calculated again by the runs that take up the rest, until the workbook is edited or a time is given", async () => {
      const workbook = await openXlsx(
        await buildXlsx({ sheets: [{ name: "S", rows: `<row r="1">${num("A1", 1)}${fx("B1", KEPT, 46349)}${fx("C1", KEPT, 46349)}</row>` }] }),
      );
      const sheet = workbook.listSheets()[0]!.id;
      const runs = (): boolean[] => {
        const results: boolean[] = [];
        for (let i = 0; i < 4 && results.at(-1) !== true; i++) results.push(workbook.recalc({ maxCells: 1 }).complete);
        return results;
      };
      expect(runs()).toEqual([false, true]);
      expect(needsRecalc(stateOf(workbook))).toBe(false);
      // Without an edit or a time, calculating them again would keep them again: an explicit run does not.
      expect(runs()).toEqual([true]);
      workbook.setCell(sheet, parseA1("A1"), 2);
      // After the edit the first formula is calculated again and takes the budget; the second follows in the next run.
      expect(workbook.recalc({ maxCells: 1 }).complete).toBe(false);
      expect(workbook.recalc({ maxCells: 1 }).complete).toBe(true);
      expect(needsRecalc(stateOf(workbook))).toBe(false);
      expect([valueAt(workbook, "S", "B1"), valueAt(workbook, "S", "C1")]).toEqual([46349, 46349]);
      workbook.setCell(sheet, parseA1("A1"), 3);
      expect(workbook.recalc({ maxCells: 1 }).complete).toBe(false);
      // Given a time, a run that takes up the rest calculates again the formula the run without one kept.
      expect(workbook.recalc({ now: "2026-12-01T10:00:00Z", maxCells: 5 }).complete).toBe(true);
      expect([valueAt(workbook, "S", "B1"), valueAt(workbook, "S", "C1")]).toEqual([46357, 46357]);
    });

    it("lets save finish a calculation larger than one run, with nothing pending", async () => {
      const count = 200_001;
      const parts = [`<row r="1">${num("A1", 1)}<c r="B1"><f t="shared" ref="B1:B${count}" si="0">${KEPT}</f><v>46349</v></c></row>`];
      for (let r = 2; r <= count; r++) parts.push(`<row r="${r}"><c r="B${r}"><f t="shared" si="0"/><v>46349</v></c></row>`);
      parts.push(`<row r="${count + 1}"><c r="C${count + 1}"><f>A1*3</f><v>3</v></c></row>`);
      const workbook = await openXlsx(await buildXlsx({ sheets: [{ name: "S", rows: parts.join("") }] }));
      workbook.setCell(workbook.listSheets()[0]!.id, parseA1("A1"), 2);
      const saved = await workbook.save();
      expect(needsRecalc(stateOf(workbook))).toBe(false);
      const reopened = await openXlsx(saved);
      expect([valueAt(reopened, "S", "B1"), valueAt(reopened, "S", `B${count}`), valueAt(reopened, "S", `C${count + 1}`)]).toEqual([
        46349, 46349, 6,
      ]);
    }, 120_000);
  });

  // Outcome protected: a date formula kept because a random draw sent it to the clock draws again in the next
  // calculation the caller asks for, and gives its answer once the draw no longer needs the time, while the runs that
  // take up the same bounded calculation do not draw it again. Fault detected: the kept formula held until an edit or
  // a time, so its saved date stays frozen however often the caller recalculates.
  describe("a date formula that reached the clock through a random draw", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    const DRAWS = ["IF(RAND()<0.5,TODAY(),42)", "IF(RANDBETWEEN(1,2)=1,TODAY(),42)", 'IF(RAND()<0.5,TODAY(),IF(TRUE,42,INDIRECT("A1")))'];

    async function drawBook(...formulas: string[]): Promise<Workbook> {
      const cells = formulas.map((formula, i) => fx(`${String.fromCharCode(66 + i)}1`, formula.replaceAll("<", "&lt;"), 46349)).join("");
      return openXlsx(await buildXlsx({ sheets: [{ name: "S", rows: `<row r="1">${num("A1", 1)}${cells}</row>` }] }));
    }

    it.each(DRAWS)(
      "draws %s again in a new calculation without a time",
      async (formula) => {
        const workbook = await drawBook(formula);
        vi.spyOn(Math, "random").mockReturnValueOnce(0.1).mockReturnValueOnce(0.9);
        expect(workbook.recalc().complete).toBe(true);
        expect(valueAt(workbook, "S", "B1")).toBe(46349);
        expect(workbook.recalc().complete).toBe(true);
        expect(valueAt(workbook, "S", "B1")).toBe(42);
      },
    );

    it.each(DRAWS)(
      "does not draw %s again in the runs that take up the same bounded calculation",
      async (formula) => {
        const workbook = await drawBook(formula, formula);
        const random = vi.spyOn(Math, "random").mockReturnValue(0.1);
        expect(workbook.recalc({ maxCells: 1 }).complete).toBe(false);
        expect(workbook.recalc({ maxCells: 1 }).complete).toBe(true);
        expect(random).toHaveBeenCalledTimes(2);
        expect(needsRecalc(stateOf(workbook))).toBe(false);
        // A new calculation draws both again; the run that takes up its rest draws only the one it did not reach.
        expect(workbook.recalc({ maxCells: 1 }).complete).toBe(false);
        expect(workbook.recalc({ maxCells: 1 }).complete).toBe(true);
        expect(random).toHaveBeenCalledTimes(4);
        // The run save makes on its own leaves volatile formulas alone.
        await workbook.save();
        expect(random).toHaveBeenCalledTimes(4);
        expect([valueAt(workbook, "S", "B1"), valueAt(workbook, "S", "C1")]).toEqual([46349, 46349]);
      },
    );
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

  // Outcome protected: the formula itself decides. It is calculated as usual, and the date is kept only when the
  // calculation reaches TODAY or NOW; no function that handles errors can turn the missing time into an answer.
  // Fault detected: an analysis of what the formula might read keeping a stale date or writing #N/A.
  describe("keeps the saved date exactly when the answer needs the time", () => {
    async function book(formula: string): Promise<Uint8Array> {
      const workbook = createXlsx({ sheetNames: ["S", "T"] });
      const [s, t] = workbook.listSheets().map((info) => info.id) as [string, string];
      workbook.setCell(s, parseA1("A5"), 5);
      workbook.setFormula(t, parseA1("B1"), formula);
      workbook.recalc({ now: NOW });
      return workbook.save();
    }

    it("gives the new answer of a position read through a reference INDIRECT returns, after inserting rows", async () => {
      const workbook = await openXlsx(await book('IF(ROW(INDIRECT("S!A"&ROW(S!A5)))=5,TODAY(),42)'));
      workbook.insertRows(workbook.listSheets()[0]!.id, 2, 2);
      const reopened = await openXlsx(await workbook.save());
      expect(valueAt(reopened, "T", "B1")).toBe(42);
    });

    it("keeps the date of a formula whose branch that reads the edited cell is never taken", async () => {
      const workbook = await openXlsx(await book('IF(TRUE,TODAY(),INDIRECT("S!A5"))'));
      workbook.setCell(workbook.listSheets()[0]!.id, parseA1("A5"), 9);
      const reopened = await openXlsx(await workbook.save());
      expect(valueAt(reopened, "T", "B1")).toBe(46349);
    });

    it.each(["IFERROR(TODAY(),0)", "IF(ISNA(NOW()),0,TODAY())", "IF(ISERROR(TODAY()+S!A5),0,TODAY())"])(
      "keeps the date of %s, whose error handling cannot catch the missing time",
      async (formula) => {
        const workbook = await openXlsx(await book(formula));
        workbook.setCell(workbook.listSheets()[0]!.id, parseA1("A5"), 9);
        workbook.insertRows(workbook.listSheets()[0]!.id, 0, 1);
        const reopened = await openXlsx(await workbook.save());
        expect(valueAt(reopened, "T", "B1")).toBe(46349);
      },
    );
  });
});
