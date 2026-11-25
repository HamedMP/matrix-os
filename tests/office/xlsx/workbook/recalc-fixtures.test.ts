import { describe, expect, it } from "vitest";
import type { CellValue } from "../../../../packages/office/src/api/xlsx.js";
import { openXlsx, parseA1 } from "../../../../packages/office/src/xlsx/index.js";
import { at, buildXlsx, err, fx, loadFixture, num, sheetId, valueAt } from "./helpers.js";

/** Asserts that two cell values are the same, allowing the last bits of a number to differ. */
function expectSameValue(actual: CellValue, expected: CellValue, where: string): void {
  if (typeof actual === "number" && typeof expected === "number") {
    expect(Math.abs(actual - expected), where).toBeLessThanOrEqual(Math.abs(expected) * 1e-12 + 1e-12);
  } else {
    expect(actual, where).toEqual(expected);
  }
}

describe.each(["formulas.xlsx", "multi-sheet.xlsx", "model.xlsx"])("calculating all of %s", (name) => {
  it("arrives at the values the file was saved with", async () => {
    const workbook = await openXlsx(loadFixture(name));
    const stored = new Map<string, CellValue>();
    for (const sheet of workbook.listSheets()) {
      if (sheet.dimensions === null) continue;
      workbook.getRange(sheet.id, sheet.dimensions).forEach((line, r) =>
        line.forEach((cell, c) => {
          if (cell.formula !== null) stored.set(`${sheet.name}!${r},${c}`, cell.value);
        }),
      );
    }
    expect(stored.size).toBeGreaterThan(5);
    // Changing a defined name puts every formula out of date.
    workbook.setDefinedName({ name: "Recalc_Everything", refersTo: "1", scope: null });
    const result = workbook.recalc({ now: "2026-11-23T09:00:00Z" });
    expect(result.complete).toBe(true);
    expect(result.circular).toEqual([]);
    for (const sheet of workbook.listSheets()) {
      if (sheet.dimensions === null) continue;
      workbook.getRange(sheet.id, sheet.dimensions).forEach((line, r) =>
        line.forEach((cell, c) => {
          if (cell.formula === null) return;
          const key = `${sheet.name}!${r},${c}`;
          expectSameValue(cell.value, stored.get(key) ?? null, `${key} = ${cell.formula}`);
        }),
      );
    }
  });
});

describe("the financial model", () => {
  it("follows a change of an assumption through the projection to the summary", async () => {
    const workbook = await openXlsx(loadFixture("model.xlsx"));
    // Monthly growth 3% -> 0%: every month has the starting revenue.
    workbook.setCell(sheetId(workbook, "Assumptions"), parseA1("B3"), 0);
    const result = workbook.recalc();
    expect(result.complete).toBe(true);
    for (const column of ["B", "C", "H", "M"]) expect(valueAt(workbook, "Projection", `${column}4`)).toBe(50000);
    expect(valueAt(workbook, "Projection", "N4")).toBe(600000);
    expect(at(workbook, "Projection", "N4").display).toBe("600,000");
    expect(valueAt(workbook, "Projection", "C5")).toBe(20000);
    // The typed-in total on the summary is a literal and stays as it is.
    expect(valueAt(workbook, "Summary", "B2")).toBe(725000);
    const reopened = await openXlsx(await workbook.save());
    expect(valueAt(reopened, "Projection", "N4")).toBe(600000);
    expect(reopened.recalc().changed).toEqual([]);
  });
});

describe("formulas the engine cannot calculate", () => {
  const source = () =>
    buildXlsx({
      sheets: [
        {
          name: "S",
          rows:
            `<row r="1">${num("A1", 2)}${fx("B1", "_xlfn.FUTUREFN(A1)", 7)}${fx("C1", "B1*10", 70)}${fx("D1", "A1 B1:B2", 5)}</row>` +
            `<row r="2">${fx("A2", "A1*3", 6)}</row>`,
        },
      ],
    });

  it("keeps their stored value, flags them and calculates around them", async () => {
    const workbook = await openXlsx(await source());
    const id = sheetId(workbook, "S");
    expect(at(workbook, "S", "B1")).toMatchObject({ value: 7, formula: "_xlfn.FUTUREFN(A1)", formulaUnsupported: true });
    expect(at(workbook, "S", "D1")).toMatchObject({ value: 5, formulaUnsupported: true });
    expect(at(workbook, "S", "C1").formulaUnsupported).toBe(false);
    workbook.setCell(id, parseA1("A1"), 4);
    const result = workbook.recalc();
    expect(result.changed.map((cell) => [cell.row, cell.col, cell.value])).toEqual([[1, 0, 12]]);
    expect(valueAt(workbook, "S", "B1")).toBe(7);
    expect(valueAt(workbook, "S", "C1")).toBe(70);
    expect(valueAt(workbook, "S", "D1")).toBe(5);
    // Saved as they were, formula text included.
    const reopened = await openXlsx(await workbook.save());
    expect(at(reopened, "S", "B1")).toMatchObject({ value: 7, formula: "_xlfn.FUTUREFN(A1)" });
    expect(await reopened.package.getPartText("/xl/worksheets/sheet1.xml")).toContain('<c r="B1"><f>_xlfn.FUTUREFN(A1)</f><v>7</v></c>');
  });

  it("rewrites their references like any other formula", async () => {
    const workbook = await openXlsx(await source());
    workbook.insertRows(sheetId(workbook, "S"), 0, 2);
    expect(at(workbook, "S", "B3")).toMatchObject({ value: 7, formula: "_xlfn.FUTUREFN(A3)" });
    expect(at(workbook, "S", "D3")).toMatchObject({ value: 5, formula: "A3 B3:B4" });
  });

  it("keeps the stored value of a formula whose defined names call an unknown function", async () => {
    const workbook = await openXlsx(
      await buildXlsx({
        sheets: [
          {
            name: "S",
            rows:
              `<row r="1">${num("A1", 2)}${fx("B1", "CustomTotal", 99)}${fx("C1", "Wrapped+1", 100)}${fx("D1", "Local*2", 8)}${fx("E1", "Plain*2", 4)}</row>`,
          },
        ],
        definedNames:
          '<definedName name="CustomTotal">_xlfn.UNSUPPORTED(S!$A$1)</definedName>' +
          '<definedName name="Wrapped">CustomTotal</definedName>' +
          '<definedName name="Local" localSheetId="0">_xlfn.OTHERFN(S!$A$1)</definedName>' +
          '<definedName name="Plain">S!$A$1</definedName>',
      }),
    );
    const id = sheetId(workbook, "S");
    expect(at(workbook, "S", "B1")).toMatchObject({ value: 99, formulaUnsupported: true });
    expect(at(workbook, "S", "C1")).toMatchObject({ value: 100, formulaUnsupported: true });
    expect(at(workbook, "S", "D1")).toMatchObject({ value: 8, formulaUnsupported: true });
    expect(at(workbook, "S", "E1").formulaUnsupported).toBe(false);
    workbook.setCell(id, parseA1("A1"), 5);
    workbook.recalc();
    expect(valueAt(workbook, "S", "B1")).toBe(99);
    expect(valueAt(workbook, "S", "C1")).toBe(100);
    expect(valueAt(workbook, "S", "D1")).toBe(8);
    expect(valueAt(workbook, "S", "E1")).toBe(10);
    // Redefining the name to something the engine calculates lets the formula calculate again.
    workbook.setDefinedName({ name: "CustomTotal", refersTo: "S!$A$1*3", scope: null });
    workbook.recalc();
    expect(at(workbook, "S", "B1")).toMatchObject({ value: 15, formulaUnsupported: false });
    expect(valueAt(workbook, "S", "C1")).toBe(16);
  });

  it("shows #NAME? for a new formula with an unknown function", async () => {
    const workbook = await openXlsx(await source());
    const id = sheetId(workbook, "S");
    workbook.setFormula(id, parseA1("E1"), "NOSUCHFUNCTION(A1)+1");
    expect(at(workbook, "S", "E1")).toMatchObject({ value: null, formulaUnsupported: true });
    workbook.recalc();
    expect(valueAt(workbook, "S", "E1")).toEqual(err("#NAME?"));
  });
});
