import { describe, expect, it } from "vitest";
import { openXlsx, parseA1 } from "../../../../packages/office/src/xlsx/index.js";
import { at, codeOf, err, loadFixture, sheetId, storedRecords, valueAt } from "./helpers.js";

describe("setting values", () => {
  it("replaces values of every type and keeps the cell style", async () => {
    const workbook = await openXlsx(loadFixture("basic.xlsx"));
    const id = sheetId(workbook, "Basics");
    workbook.setCell(id, parseA1("B2"), 43);
    workbook.setCell(id, parseA1("B3"), "now text");
    workbook.setCell(id, parseA1("B4"), true);
    workbook.setCell(id, parseA1("B5"), err("#DIV/0!"));
    workbook.setCell(id, parseA1("B6"), null);
    workbook.setCell(id, parseA1("B11"), 46096);
    workbook.setCell(id, parseA1("D30"), "=not a formula");
    expect(at(workbook, "Basics", "B2")).toMatchObject({ value: 43, display: "43" });
    expect(valueAt(workbook, "Basics", "B3")).toBe("now text");
    expect(at(workbook, "Basics", "B4")).toMatchObject({ value: true, display: "TRUE" });
    expect(at(workbook, "Basics", "B5")).toMatchObject({ value: err("#DIV/0!"), display: "#DIV/0!" });
    expect(at(workbook, "Basics", "B6")).toMatchObject({ value: null, display: "" });
    expect(at(workbook, "Basics", "B11")).toMatchObject({ value: 46096, styleId: 1, display: "2026-03-15" });
    expect(at(workbook, "Basics", "D30")).toMatchObject({ value: "=not a formula", formula: null });
    expect(workbook.getSheet(id).dimensions).toEqual({ start: { row: 0, col: 0 }, end: { row: 29, col: 4 } });

    const reopened = await openXlsx(await workbook.save());
    expect(at(reopened, "Basics", "B2")).toMatchObject({ value: 43, display: "43" });
    expect(valueAt(reopened, "Basics", "B3")).toBe("now text");
    expect(valueAt(reopened, "Basics", "B4")).toBe(true);
    expect(valueAt(reopened, "Basics", "B5")).toEqual(err("#DIV/0!"));
    expect(valueAt(reopened, "Basics", "B6")).toBeNull();
    expect(at(reopened, "Basics", "B11")).toMatchObject({ value: 46096, styleId: 1, display: "2026-03-15" });
    expect(valueAt(reopened, "Basics", "D30")).toBe("=not a formula");
    // Untouched cells, including the inline string and the long text, read as before.
    expect(valueAt(reopened, "Basics", "B21")).toBe("Inline string cell");
    expect(valueAt(reopened, "Basics", "B14")).toBe("Lorem ipsum ".repeat(20));
    expect(valueAt(reopened, "Basics", "B8")).toBe("Grüße – 文档 😀");
  });

  it("writes only the parts an edit touches", async () => {
    const source = loadFixture("multi-sheet.xlsx");
    const before = storedRecords(source);
    const workbook = await openXlsx(source);
    workbook.setCell(sheetId(workbook, "Q1 Sales"), parseA1("A1"), "Area");
    workbook.setCell(sheetId(workbook, "Q1 Sales"), parseA1("D9"), 12.5);
    const after = storedRecords(await workbook.save());
    const changed = [...before.keys()].filter((entry) => JSON.stringify(after.get(entry)) !== JSON.stringify(before.get(entry)));
    expect(changed.sort()).toEqual(["xl/sharedStrings.xml", "xl/worksheets/sheet2.xml"]);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  });

  it("keeps shared strings untouched when no new text is written", async () => {
    const source = loadFixture("multi-sheet.xlsx");
    const before = storedRecords(source);
    const workbook = await openXlsx(source);
    workbook.setCell(sheetId(workbook, "Q2 Sales"), parseA1("D1"), 7);
    const after = storedRecords(await workbook.save());
    const changed = [...before.keys()].filter((entry) => JSON.stringify(after.get(entry)) !== JSON.stringify(before.get(entry)));
    expect(changed).toEqual(["xl/worksheets/sheet3.xml"]);
  });

  it("writes text through the shared string table, reusing equal text", async () => {
    const workbook = await openXlsx(loadFixture("basic.xlsx"));
    const id = sheetId(workbook, "Basics");
    workbook.setRange(id, parseA1("G1"), [
      ["hello world", "brand new", "brand new"],
      ["  padded  ", "line\nbreak", "tab\there"],
      ["", "ctrl\u0001char", "_x0041_"],
    ]);
    const saved = await workbook.save();
    const strings = await workbook.package.getPartText("/xl/sharedStrings.xml");
    expect(strings.match(/<si>/g)?.length).toBe(29 + 7);
    expect(strings).toContain('uniqueCount="36"');
    expect(strings).toContain('<t xml:space="preserve">  padded  </t>');
    const sheet = await workbook.package.getPartText("/xl/worksheets/sheet1.xml");
    expect(sheet).toContain('<c r="G1" t="s"><v>10</v></c>');
    const reopened = await openXlsx(saved);
    const grid = reopened.getRange(sheetId(reopened, "Basics"), { start: { row: 0, col: 6 }, end: { row: 2, col: 8 } });
    expect(grid.map((line) => line.map((cell) => cell.value))).toEqual([
      ["hello world", "brand new", "brand new"],
      ["  padded  ", "line\nbreak", "tab\there"],
      ["", "ctrl\u0001char", "_x0041_"],
    ]);
  });

  it("sets ranges with rows of different lengths", async () => {
    const workbook = await openXlsx(loadFixture("basic.xlsx"));
    const id = sheetId(workbook, "Basics");
    workbook.setRange(id, { row: 24, col: 1 }, [[1, 2, 3], [], [null, "x"]]);
    expect(workbook.getRange(id, { start: { row: 24, col: 1 }, end: { row: 26, col: 3 } }).map((line) => line.map((cell) => cell.value))).toEqual([
      [1, 2, 3],
      [null, null, null],
      [null, "x", null],
    ]);
  });

  it("rejects bad arguments and leaves the workbook as it was", async () => {
    const workbook = await openXlsx(loadFixture("basic.xlsx"));
    const id = sheetId(workbook, "Basics");
    expect(codeOf(() => workbook.setCell("nope", parseA1("A1"), 1))).toBe("not_found");
    expect(codeOf(() => workbook.getCell("nope", parseA1("A1")))).toBe("not_found");
    expect(codeOf(() => workbook.setCell(id, { row: -1, col: 0 }, 1))).toBe("invalid_argument");
    expect(codeOf(() => workbook.setCell(id, { row: 0, col: 16384 }, 1))).toBe("invalid_argument");
    expect(codeOf(() => workbook.setCell(id, { row: 0.5, col: 0 }, 1))).toBe("invalid_argument");
    expect(codeOf(() => workbook.setCell(id, parseA1("A1"), Number.NaN))).toBe("invalid_argument");
    expect(codeOf(() => workbook.setCell(id, parseA1("A1"), Number.POSITIVE_INFINITY))).toBe("invalid_argument");
    expect(codeOf(() => workbook.setCell(id, parseA1("A1"), "x".repeat(32768)))).toBe("invalid_argument");
    expect(codeOf(() => workbook.setCell(id, parseA1("A1"), { kind: "error", code: "#BOGUS" } as never))).toBe("invalid_argument");
    expect(codeOf(() => workbook.setCell(id, parseA1("A1"), {} as never))).toBe("invalid_argument");
    expect(codeOf(() => workbook.setRange(id, parseA1("XFD1"), [[1, 2]]))).toBe("invalid_argument");
    expect(codeOf(() => workbook.setRange(id, parseA1("A1"), [[1, Number.NaN]]))).toBe("invalid_argument");
    expect(codeOf(() => workbook.getRange(id, { start: { row: 0, col: 0 }, end: { row: 1048575, col: 16383 } }))).toBe("limit_exceeded");
    expect(valueAt(workbook, "Basics", "A1")).toBe("Label");
    for (const part of workbook.package.listParts()) expect(part.modified).toBe(false);
  });
});

describe("formulas and recalculation", () => {
  it("recalculates dependants after an edit and writes the cached values", async () => {
    const workbook = await openXlsx(loadFixture("formulas.xlsx"));
    const data = sheetId(workbook, "Data");
    const calc = sheetId(workbook, "Calc");
    workbook.setCell(data, parseA1("D2"), 50);
    // Nothing is calculated until recalc runs.
    expect(valueAt(workbook, "Data", "E2")).toBe(500);
    const result = workbook.recalc();
    expect(result.complete).toBe(true);
    expect(result.circular).toEqual([]);
    const changed = Object.fromEntries(result.changed.map((cell) => [`${cell.sheet}!${cell.row},${cell.col}`, [cell.previous, cell.value]]));
    expect(changed[`${data}!1,4`]).toEqual([500, 625]);
    expect(changed[`${data}!1,5`]).toEqual([600, 750]);
    expect(changed[`${calc}!0,1`]).toEqual([237, 247]);
    expect(valueAt(workbook, "Calc", "B11")).toBeCloseTo(1596.13, 9);
    expect(valueAt(workbook, "Calc", "B9")).toBe(true);
    // Formulas that do not depend on the edit were not touched.
    expect(result.changed.some((cell) => cell.sheet === calc && cell.row === 3)).toBe(false);
    expect(workbook.recalc().changed).toEqual([]);

    const reopened = await openXlsx(await workbook.save());
    expect(at(reopened, "Data", "E2")).toMatchObject({ value: 625, formula: "C2*D2" });
    expect(at(reopened, "Calc", "B1")).toMatchObject({ value: 247, formula: "SUM(Data!D2:D6)" });
    expect(at(reopened, "Calc", "B3")).toMatchObject({ value: "Yes" });
    expect(at(reopened, "Calc", "B10")).toMatchObject({ value: err("#N/A") });
    // The array formula survives with its range.
    expect(await reopened.package.getPartText("/xl/worksheets/sheet2.xml")).toContain('<f t="array" ref="D2:D6">Data!C2:C6*Data!D2:D6</f>');
  });

  it("calculates on save when the caller did not", async () => {
    const workbook = await openXlsx(loadFixture("formulas.xlsx"));
    workbook.setCell(sheetId(workbook, "Calc"), parseA1("B6"), 0.25);
    const reopened = await openXlsx(await workbook.save());
    expect(valueAt(reopened, "Data", "F2")).toBe(625);
    expect(valueAt(reopened, "Calc", "B8")).toBeCloseTo(1838.9125, 9);
  });

  it("sets, replaces and removes formulas", async () => {
    const workbook = await openXlsx(loadFixture("formulas.xlsx"));
    const data = sheetId(workbook, "Data");
    workbook.setFormula(data, parseA1("G2"), "=E2+F2");
    workbook.setFormula(data, parseA1("G3"), "SUM(E2:E6)/2");
    expect(at(workbook, "Data", "G2")).toMatchObject({ value: null, formula: "E2+F2", display: "" });
    workbook.recalc();
    expect(valueAt(workbook, "Data", "G2")).toBe(1100);
    expect(valueAt(workbook, "Data", "G3")).toBeCloseTo(735.565, 9);
    // A formula that does not parse changes nothing.
    expect(codeOf(() => workbook.setFormula(data, parseA1("G2"), "=SUM(E2,"))).toBe("formula_error");
    expect(codeOf(() => workbook.setFormula(data, parseA1("G2"), "="))).toBe("formula_error");
    expect(at(workbook, "Data", "G2")).toMatchObject({ value: 1100, formula: "E2+F2" });
    // Removing a formula keeps the value as a literal.
    workbook.setFormula(data, parseA1("G2"), null);
    expect(at(workbook, "Data", "G2")).toMatchObject({ value: 1100, formula: null });
    workbook.setFormula(data, parseA1("G2"), null);
    // A literal over a formula removes it.
    workbook.setCell(data, parseA1("E2"), 1);
    expect(at(workbook, "Data", "E2")).toMatchObject({ value: 1, formula: null });
    workbook.recalc();
    expect(valueAt(workbook, "Data", "F2")).toBe(1.2);
    const reopened = await openXlsx(await workbook.save());
    expect(at(reopened, "Data", "G3")).toMatchObject({ formula: "SUM(E2:E6)/2" });
    expect(at(reopened, "Data", "E2")).toMatchObject({ value: 1, formula: null });
    expect(await reopened.package.getPartText("/xl/worksheets/sheet1.xml")).toContain('<c r="G3"><f>SUM(E2:E6)/2</f><v>');
  });

  it("writes text, boolean and error results with their cell types", async () => {
    const workbook = await openXlsx(loadFixture("formulas.xlsx"));
    const data = sheetId(workbook, "Data");
    workbook.setFormula(data, parseA1("H1"), 'A2&" / "&B2');
    workbook.setFormula(data, parseA1("H2"), "C2>100");
    workbook.setFormula(data, parseA1("H3"), "1/0");
    workbook.setFormula(data, parseA1("H4"), "Z99");
    workbook.recalc();
    expect(valueAt(workbook, "Data", "H1")).toBe("SKU-001 / Gadget");
    expect(valueAt(workbook, "Data", "H2")).toBe(false);
    expect(valueAt(workbook, "Data", "H3")).toEqual(err("#DIV/0!"));
    expect(valueAt(workbook, "Data", "H4")).toBe(0);
    await workbook.save();
    const xml = await workbook.package.getPartText("/xl/worksheets/sheet1.xml");
    expect(xml).toContain('<c r="H1" t="str"><f>A2&amp;" / "&amp;B2</f><v>SKU-001 / Gadget</v></c>');
    expect(xml).toContain('<c r="H2" t="b"><f>C2&gt;100</f><v>0</v></c>');
    expect(xml).toContain('<c r="H3" t="e"><f>1/0</f><v>#DIV/0!</v></c>');
    expect(xml).toContain('<c r="H4"><f>Z99</f><v>0</v></c>');
  });

  it("reports circular references and gives their cells #REF!", async () => {
    const workbook = await openXlsx(loadFixture("formulas.xlsx"));
    const data = sheetId(workbook, "Data");
    workbook.setFormula(data, parseA1("J1"), "J2+1");
    workbook.setFormula(data, parseA1("J2"), "J3+1");
    workbook.setFormula(data, parseA1("J3"), "J1+1");
    workbook.setFormula(data, parseA1("J5"), "J5*2");
    workbook.setFormula(data, parseA1("J7"), "J1+10");
    const result = workbook.recalc();
    expect(result.complete).toBe(true);
    expect(result.circular.map((cell) => `${cell.row},${cell.col}`).sort()).toEqual(["0,9", "1,9", "2,9", "4,9"]);
    expect(valueAt(workbook, "Data", "J1")).toEqual(err("#REF!"));
    expect(valueAt(workbook, "Data", "J5")).toEqual(err("#REF!"));
    expect(valueAt(workbook, "Data", "J7")).toEqual(err("#REF!"));
    // Breaking the cycle heals it.
    workbook.setCell(data, parseA1("J3"), 1);
    const healed = workbook.recalc();
    expect(healed.circular.map((cell) => `${cell.row},${cell.col}`)).toEqual(["4,9"]);
    expect(valueAt(workbook, "Data", "J1")).toBe(3);
    expect(valueAt(workbook, "Data", "J7")).toBe(13);
  });

  it("stops at the bounds and finishes on the next run", async () => {
    const workbook = await openXlsx(loadFixture("formulas.xlsx"));
    const data = sheetId(workbook, "Data");
    // Each cell reads the one below it, so the first cell is at the end of a chain of sixty.
    workbook.setCell(data, parseA1("L60"), 1);
    for (let row = 0; row < 59; row++) workbook.setFormula(data, { row, col: 11 }, `L${row + 2}+1`);
    const shallow = workbook.recalc({ maxDepth: 10 });
    expect(shallow.complete).toBe(false);
    expect(valueAt(workbook, "Data", "L1")).toBeNull();
    const few = workbook.recalc({ maxCells: 5 });
    expect(few.complete).toBe(false);
    expect(few.changed.length).toBe(5);
    expect(valueAt(workbook, "Data", "L59")).toBe(2);
    const full = workbook.recalc();
    expect(full.complete).toBe(true);
    expect(valueAt(workbook, "Data", "L1")).toBe(60);
    // A chain far deeper than the call stack could take.
    workbook.setCell(data, { row: 30000, col: 13 }, 1);
    for (let row = 0; row < 30000; row++) workbook.setFormula(data, { row, col: 13 }, `N${row + 2}+1`);
    expect(workbook.recalc({ maxDepth: 40000 }).complete).toBe(true);
    expect(valueAt(workbook, "Data", "N1")).toBe(30001);
    expect(workbook.recalc().complete).toBe(true);
  });

  it("lists precedents and dependents", async () => {
    const workbook = await openXlsx(loadFixture("formulas.xlsx"));
    const data = sheetId(workbook, "Data");
    const calc = sheetId(workbook, "Calc");
    expect(workbook.precedents(data, parseA1("F2"))).toEqual([
      { sheet: data, start: { row: 1, col: 4 }, end: { row: 1, col: 4 } },
      { sheet: calc, start: { row: 5, col: 1 }, end: { row: 5, col: 1 } },
    ]);
    expect(workbook.precedents(calc, parseA1("B1"))).toEqual([{ sheet: data, start: { row: 1, col: 3 }, end: { row: 5, col: 3 } }]);
    // A defined name is followed to the cell it names.
    expect(workbook.precedents(calc, parseA1("B8"))).toEqual([
      { sheet: calc, start: { row: 6, col: 1 }, end: { row: 6, col: 1 } },
      { sheet: calc, start: { row: 5, col: 1 }, end: { row: 5, col: 1 } },
    ]);
    expect(workbook.precedents(data, parseA1("A1"))).toEqual([]);
    expect(workbook.dependents(calc, parseA1("B6"))).toEqual([
      { sheet: data, row: 1, col: 5 },
      { sheet: data, row: 2, col: 5 },
      { sheet: data, row: 3, col: 5 },
      { sheet: data, row: 4, col: 5 },
      { sheet: data, row: 5, col: 5 },
      { sheet: calc, row: 7, col: 1 },
    ]);
    expect(workbook.dependents(data, parseA1("A1"))).toEqual([]);
  });
});
