import { describe, expect, it } from "vitest";
import { openXlsx, parseA1, parseA1Range } from "../../../../packages/office/src/xlsx/index.js";
import { getWorkbookInternals } from "../../../../packages/office/src/xlsx/internal.js";
import { at, buildXlsx, codeOf, err, fx, loadFixture, num, sheetId, valueAt } from "./helpers.js";

const arrayFx = (ref: string, range: string, formula: string, cached: number): string =>
  `<c r="${ref}"><f t="array" ref="${range}">${formula}</f><v>${cached}</v></c>`;

describe("the array formula of formulas.xlsx", () => {
  it("is calculated, not only kept", async () => {
    const workbook = await openXlsx(loadFixture("formulas.xlsx"));
    expect(at(workbook, "Calc", "D2")).toMatchObject({ value: 500, formula: "Data!C2:C6*Data!D2:D6", formulaUnsupported: false });
    const stored = ["D2", "D3", "D4", "D5", "D6"].map((cell) => valueAt(workbook, "Calc", cell));
    // Putting everything out of date must arrive at the stored values again.
    workbook.setDefinedName({ name: "Recalc_Everything", refersTo: "1", scope: null });
    expect(workbook.recalc().changed).toEqual([]);
    expect(["D2", "D3", "D4", "D5", "D6"].map((cell) => valueAt(workbook, "Calc", cell))).toEqual(stored);
  });

  it("fills its whole range when an input changes", async () => {
    const workbook = await openXlsx(loadFixture("formulas.xlsx"));
    const data = sheetId(workbook, "Data");
    const calc = sheetId(workbook, "Calc");
    const price = valueAt(workbook, "Data", "C4") as number;
    workbook.setCell(data, parseA1("D2"), 30);
    workbook.setCell(data, parseA1("D4"), 20);
    const result = workbook.recalc();
    expect(valueAt(workbook, "Calc", "D2")).toBe((valueAt(workbook, "Data", "C2") as number) * 30);
    expect(valueAt(workbook, "Calc", "D4")).toBeCloseTo(price * 20, 9);
    expect(valueAt(workbook, "Calc", "D3")).toBe(206.25);
    const changedInCalcD = result.changed.filter((cell) => cell.sheet === calc && cell.col === 3).map((cell) => cell.row);
    expect(changedInCalcD).toEqual([1, 3]);
    // A filled cell is still a value without a formula of its own.
    expect(at(workbook, "Calc", "D4").formula).toBeNull();
  });

  it("is calculated before the formulas that read its range", async () => {
    const workbook = await openXlsx(loadFixture("formulas.xlsx"));
    const calc = sheetId(workbook, "Calc");
    workbook.setFormula(calc, parseA1("F1"), "D4*2");
    workbook.setFormula(calc, parseA1("F2"), "SUM(D2:D6)");
    workbook.recalc();
    const before = valueAt(workbook, "Calc", "F2") as number;
    workbook.setCell(sheetId(workbook, "Data"), parseA1("D4"), 20);
    workbook.recalc();
    const filled = valueAt(workbook, "Calc", "D4") as number;
    expect(valueAt(workbook, "Calc", "F1")).toBeCloseTo(filled * 2, 9);
    expect(valueAt(workbook, "Calc", "F2")).not.toBe(before);
    expect(workbook.dependents(sheetId(workbook, "Data"), parseA1("D4")).some((cell) => cell.sheet === calc && cell.row === 1 && cell.col === 3)).toBe(true);
  });

  it("writes a value that got into its range by another way back at the next calculation", async () => {
    const workbook = await openXlsx(loadFixture("formulas.xlsx"));
    const calc = sheetId(workbook, "Calc");
    getWorkbookInternals(workbook).writeRawCell(calc, parseA1("D3"), { value: 1, formula: null, styleId: 0 });
    expect(valueAt(workbook, "Calc", "D3")).toBe(1);
    workbook.recalc();
    expect(valueAt(workbook, "Calc", "D3")).toBe(206.25);
  });

  it("names its range on every cell it fills", async () => {
    const workbook = await openXlsx(loadFixture("formulas.xlsx"));
    const range = parseA1Range("D2:D6");
    expect(at(workbook, "Calc", "D2").arrayRange).toEqual(range);
    expect(at(workbook, "Calc", "D6").arrayRange).toEqual(range);
    expect(at(workbook, "Calc", "D7").arrayRange).toBeNull();
    expect(at(workbook, "Calc", "B1").arrayRange).toBeNull();
    expect(at(workbook, "Data", "D2").arrayRange).toBeNull();
    workbook.insertRows(sheetId(workbook, "Calc"), 0, 3);
    expect(at(workbook, "Calc", "D9").arrayRange).toEqual(parseA1Range("D5:D9"));
    expect(at(workbook, "Calc", "D4").arrayRange).toBeNull();
  });

  it("refuses an edit to part of its range and changes nothing", async () => {
    const workbook = await openXlsx(loadFixture("formulas.xlsx"));
    const calc = sheetId(workbook, "Calc");
    const before = workbook.getRange(calc, parseA1Range("C1:E7"));
    expect(codeOf(() => workbook.setCell(calc, parseA1("D3"), 1))).toBe("invalid_operation");
    expect(codeOf(() => workbook.setCell(calc, parseA1("D2"), 1))).toBe("invalid_operation");
    expect(codeOf(() => workbook.setCellInput(calc, parseA1("D4"), "12"))).toBe("invalid_operation");
    expect(codeOf(() => workbook.setFormula(calc, parseA1("D5"), "1+1"))).toBe("invalid_operation");
    expect(codeOf(() => workbook.setFormula(calc, parseA1("D2"), null))).toBe("invalid_operation");
    expect(codeOf(() => workbook.setRange(calc, parseA1("C5"), [["a", 1], ["b", 2], ["c", 3]]))).toBe("invalid_operation");
    expect(codeOf(() => workbook.clearRange(calc, parseA1Range("D3:D4")))).toBe("invalid_operation");
    expect(codeOf(() => workbook.clearRange(calc, parseA1Range("A1:D5"), "all"))).toBe("invalid_operation");
    expect(workbook.getRange(calc, parseA1Range("C1:E7"))).toEqual(before);
    // Formats are not content.
    workbook.clearRange(calc, parseA1Range("D3:D4"), "formats");
    workbook.setStyle(calc, parseA1Range("D2:D3"), { font: { bold: true } });
    expect(at(workbook, "Calc", "D2").formula).toBe("Data!C2:C6*Data!D2:D6");
    expect(workbook.recalc().changed).toEqual([]);
  });

  it("is removed by an edit that covers its whole range", async () => {
    const cleared = await openXlsx(loadFixture("formulas.xlsx"));
    cleared.clearRange(sheetId(cleared, "Calc"), parseA1Range("D2:D6"));
    expect(["D2", "D3", "D6"].map((cell) => at(cleared, "Calc", cell))).toMatchObject([
      { value: null, formula: null, arrayRange: null },
      { value: null, formula: null, arrayRange: null },
      { value: null, formula: null, arrayRange: null },
    ]);
    const replaced = await openXlsx(loadFixture("formulas.xlsx"));
    const calc = sheetId(replaced, "Calc");
    replaced.setRange(calc, parseA1("D1"), [["Totals"], [1], [2], [3], [4], [5], [6]]);
    replaced.setCell(sheetId(replaced, "Data"), parseA1("D2"), 99);
    replaced.recalc();
    expect(["D2", "D3", "D6", "D7"].map((cell) => valueAt(replaced, "Calc", cell))).toEqual([1, 2, 5, 6]);
    expect(at(replaced, "Calc", "D2")).toMatchObject({ formula: null, arrayRange: null });
    const xml = await (await openXlsx(await replaced.save())).package.getPartText("/xl/worksheets/sheet2.xml");
    expect(xml).not.toContain('t="array"');
  });

  it("cannot be changed inside a proposal, where the change could not be taken back", async () => {
    const workbook = await openXlsx(loadFixture("formulas.xlsx"));
    const calc = sheetId(workbook, "Calc");
    workbook.beginProposal({ author: "a", date: "2026-11-23T00:00:00Z", label: "x" });
    expect(codeOf(() => workbook.clearRange(calc, parseA1Range("D2:D6")))).toBe("invalid_operation");
    expect(codeOf(() => workbook.setRange(calc, parseA1("D2"), [[1], [2], [3], [4], [5]]))).toBe("invalid_operation");
    workbook.endProposal();
    expect(workbook.listChanges()).toEqual([]);
    expect(at(workbook, "Calc", "D2").formula).toBe("Data!C2:C6*Data!D2:D6");
  });

  it("is saved with its range and the new values", async () => {
    const workbook = await openXlsx(loadFixture("formulas.xlsx"));
    workbook.setCell(sheetId(workbook, "Data"), parseA1("D3"), 100);
    const reopened = await openXlsx(await workbook.save());
    const xml = await reopened.package.getPartText("/xl/worksheets/sheet2.xml");
    expect(xml).toContain('<f t="array" ref="D2:D6">Data!C2:C6*Data!D2:D6</f>');
    expect(valueAt(reopened, "Calc", "D3")).toBeCloseTo((valueAt(reopened, "Data", "C3") as number) * 100, 9);
    expect(at(reopened, "Calc", "D3").formula).toBeNull();
  });
});

describe("array formulas in general", () => {
  const source = (extra = "") =>
    buildXlsx({
      sheets: [
        {
          name: "S",
          rows:
            `<row r="1">${num("A1", 1)}${num("B1", 10)}${arrayFx("C1", "C1", "SUM(A1:A3*B1:B3)", 140)}${arrayFx("E1", "E1:F2", "A1:A2*2", 2)}${num("F1", 2)}</row>` +
            `<row r="2">${num("A2", 2)}${num("B2", 20)}${num("E2", 4)}${num("F2", 4)}</row>` +
            `<row r="3">${num("A3", 3)}${num("B3", 30)}${extra}</row>`,
        },
      ],
    });

  it("calculates a formula entered in one cell over whole ranges", async () => {
    const workbook = await openXlsx(await source());
    expect(at(workbook, "S", "C1").formulaUnsupported).toBe(false);
    workbook.setCell(sheetId(workbook, "S"), parseA1("B3"), 100);
    workbook.recalc();
    expect(valueAt(workbook, "S", "C1")).toBe(1 * 10 + 2 * 20 + 3 * 100);
  });

  it("lets a formula entered in one cell be replaced like any other cell, outside a proposal", async () => {
    const workbook = await openXlsx(await source());
    const id = sheetId(workbook, "S");
    expect(at(workbook, "S", "C1").arrayRange).toEqual(parseA1Range("C1"));
    workbook.beginProposal({ author: "a", date: "2026-11-23T00:00:00Z", label: "x" });
    expect(codeOf(() => workbook.setCell(id, parseA1("C1"), 5))).toBe("invalid_operation");
    workbook.endProposal();
    workbook.setCell(id, parseA1("C1"), 5);
    expect(at(workbook, "S", "C1")).toMatchObject({ value: 5, formula: null, arrayRange: null });
  });

  it("repeats a single column of results across the columns of its range", async () => {
    const workbook = await openXlsx(await source());
    workbook.setCell(sheetId(workbook, "S"), parseA1("A2"), 5);
    workbook.recalc();
    expect(["E1", "F1", "E2", "F2"].map((cell) => valueAt(workbook, "S", cell))).toEqual([2, 2, 10, 10]);
  });

  it("shows #N/A where the range is larger than the result, and creates the cells it fills", async () => {
    const workbook = await openXlsx(await source(arrayFx("H3", "H3:I5", "A1:B2+0", 1)));
    workbook.setCell(sheetId(workbook, "S"), parseA1("A1"), 7);
    workbook.recalc();
    expect(["H3", "I3", "H4", "I4"].map((cell) => valueAt(workbook, "S", cell))).toEqual([7, 10, 2, 20]);
    expect(valueAt(workbook, "S", "H5")).toEqual(err("#N/A"));
    expect(valueAt(workbook, "S", "I5")).toEqual(err("#N/A"));
  });

  it("flags a circular reference through its own range", async () => {
    const workbook = await openXlsx(await source(arrayFx("H3", "H3:H4", "H4:H5+A1:A2", 1)));
    workbook.setCell(sheetId(workbook, "S"), parseA1("A1"), 7);
    const result = workbook.recalc();
    expect(result.circular).toEqual([{ sheet: sheetId(workbook, "S"), row: 2, col: 7 }]);
    expect(valueAt(workbook, "S", "H3")).toEqual(err("#REF!"));
  });

  it("keeps what it cannot calculate: data tables, unknown functions, a range too large to fill", async () => {
    const workbook = await openXlsx(
      await source(
        `<c r="H3"><f t="dataTable" ref="H3:H4" dt2D="0" r1="A1">A1</f><v>5</v></c>` +
          arrayFx("J3", "J3", "_xlfn.FUTUREFN(A1:A3)", 6) +
          arrayFx("L3", "L3:XFD1048576", "A1:A3", 7) +
          fx("K3", "A1+1", 2),
      ),
    );
    for (const cell of ["H3", "J3", "L3"]) expect(at(workbook, "S", cell).formulaUnsupported).toBe(true);
    workbook.setCell(sheetId(workbook, "S"), parseA1("A1"), 50);
    workbook.recalc();
    expect(["H3", "J3", "L3", "K3"].map((cell) => valueAt(workbook, "S", cell))).toEqual([5, 6, 7, 51]);
    const xml = await (await openXlsx(await workbook.save())).package.getPartText("/xl/worksheets/sheet1.xml");
    expect(xml).toContain('<c r="H3"><f t="dataTable" ref="H3:H4" dt2D="0" r1="A1">A1</f><v>5</v></c>');
    expect(xml).toContain('<c r="L3"><f t="array" ref="L3:XFD1048576">A1:A3</f><v>7</v></c>');
  });
});
