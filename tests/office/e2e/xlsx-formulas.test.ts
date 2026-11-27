/**
 * Acceptance check 4, second half: the formula engine arrives at the values
 * a spreadsheet application stored in the file, for every formula cell, and
 * no function a fixture uses is missing.
 *
 * The stored values are read twice: through the engine before anything is
 * calculated, and from `expected/<file>.summary.json`, which an independent
 * reader wrote from the same file.
 */

import { describe, expect, it } from "vitest";
import type { CellValue, FormulaAst, Workbook } from "../../../packages/office/src/index.js";
import { createFunctionRegistry, formatA1, openXlsx, parseA1, parseFormula } from "../../../packages/office/src/index.js";
import { XLSX_FIXTURES, expectSameValue, expectedJson, keepOutput, loadFixture, sheetId } from "./helpers.js";

interface FormulaSummary {
  cell: string;
  formula: string;
  type: "normal" | "shared" | "array";
  ref: string | null;
  cached: string | null;
}

interface WorkbookSummary {
  totalFormulas: number;
  sheets: Array<{ name: string; formulas: FormulaSummary[] }>;
}

interface FormulaCell {
  sheet: string;
  address: string;
  formula: string;
  value: CellValue;
  unsupported: boolean;
}

function formulaCells(workbook: Workbook): FormulaCell[] {
  const cells: FormulaCell[] = [];
  for (const sheet of workbook.listSheets()) {
    if (sheet.dimensions === null) continue;
    const { start } = sheet.dimensions;
    workbook.getRange(sheet.id, sheet.dimensions).forEach((line, r) =>
      line.forEach((cell, c) => {
        if (cell.formula === null) return;
        const address = formatA1({ row: start.row + r, col: start.col + c });
        cells.push({ sheet: sheet.name, address, formula: cell.formula, value: cell.value, unsupported: cell.formulaUnsupported });
      }),
    );
  }
  return cells;
}

/** The names of the functions a formula calls. */
function calledFunctions(ast: FormulaAst, into: Set<string>): void {
  const stack: FormulaAst[] = [ast];
  while (stack.length > 0) {
    const node = stack.pop() as FormulaAst;
    if (node.type === "call") {
      into.add(node.name);
      stack.push(...node.args);
    } else if (node.type === "unary") stack.push(node.operand);
    else if (node.type === "binary") stack.push(node.left, node.right);
    else if (node.type === "paren") stack.push(node.inner);
    else if (node.type === "array") for (const row of node.rows) stack.push(...row);
  }
}

/** A cell value as the independent reader wrote the cached value: text, with booleans as 1 and 0. */
function expectStored(value: CellValue, cached: string | null, where: string): void {
  expect(cached, `${where} has a stored value`).not.toBeNull();
  if (typeof value === "number") expectSameValue(value, Number(cached), where);
  else if (typeof value === "boolean") expect(["1", "TRUE", "true"].includes(cached ?? "") === value, where).toBe(true);
  else if (value !== null && typeof value === "object") expect(value.code, where).toBe(cached);
  else expect(value, where).toBe(cached);
}

/** Puts every formula out of date: a defined name changes, so nothing can be skipped. */
function invalidateEverything(workbook: Workbook): void {
  workbook.setDefinedName({ name: "Recalc_Everything", refersTo: "1", scope: null });
}

describe.each(XLSX_FIXTURES.filter((name) => name !== "basic.xlsx" && name !== "formats.xlsx"))("every formula of %s", (name) => {
  it("is calculated to the value stored in the file, with no function missing", async () => {
    const workbook = await openXlsx(loadFixture(name));
    const stored = formulaCells(workbook);
    const summary = expectedJson<WorkbookSummary>(`${name}.summary.json`);
    const expected = summary.sheets.flatMap((sheet) => sheet.formulas.map((formula) => ({ sheet: sheet.name, ...formula })));
    // The engine sees exactly the formula cells the independent reader saw, with the same stored values.
    expect(stored.map((cell) => `${cell.sheet}!${cell.address}`).sort()).toEqual(expected.map((formula) => `${formula.sheet}!${formula.cell}`).sort());
    expect(stored.length).toBe(summary.totalFormulas);
    for (const formula of expected) {
      const cell = stored.find((entry) => entry.sheet === formula.sheet && entry.address === formula.cell) as FormulaCell;
      expect(cell.formula, `${formula.sheet}!${formula.cell}`).toBe(formula.formula);
      expectStored(cell.value, formula.cached, `${formula.sheet}!${formula.cell} as stored`);
    }

    // No function is missing, and no formula is left to its stored value.
    const functions = createFunctionRegistry();
    const called = new Set<string>();
    for (const cell of stored) calledFunctions(parseFormula(cell.formula), called);
    const missing = [...called].filter((fn) => !functions.has(fn)).sort();
    expect(missing).toEqual([]);
    expect(stored.filter((cell) => cell.unsupported).map((cell) => `${cell.sheet}!${cell.address}`)).toEqual([]);

    // Calculate everything from scratch and compare, cell by cell.
    invalidateEverything(workbook);
    const result = workbook.recalc({ now: "2026-11-23T09:00:00Z" });
    expect(result).toMatchObject({ complete: true, circular: [] });
    const calculated = formulaCells(workbook);
    expect(calculated.length).toBe(stored.length);
    calculated.forEach((cell, index) => {
      const before = stored[index] as FormulaCell;
      expectSameValue(cell.value, before.value, `${cell.sheet}!${cell.address} = ${cell.formula}`);
      const formula = expected.find((entry) => entry.sheet === cell.sheet && entry.cell === cell.address) as FormulaSummary;
      expectStored(cell.value, formula.cached, `${cell.sheet}!${cell.address} = ${cell.formula}`);
    });
    // The same holds for the cells an array formula fills besides its own.
    for (const formula of expected.filter((entry) => entry.type === "array" && entry.ref !== null)) {
      const id = sheetId(workbook, formula.sheet);
      const fresh = await openXlsx(loadFixture(name));
      const [from, to] = (formula.ref as string).split(":").map((corner) => parseA1(corner));
      for (let row = (from as { row: number }).row; row <= (to ?? from)!.row; row++) {
        for (let col = from!.col; col <= (to ?? from)!.col; col++) {
          expectSameValue(workbook.getCell(id, { row, col }).value, fresh.getCell(id, { row, col }).value, `${formula.sheet}!${formatA1({ row, col })} of the array formula`);
        }
      }
    }
    workbook.removeDefinedName("Recalc_Everything");
    keepOutput(`recalculated-${name}`, await workbook.save());
  });
});

describe("the function library", () => {
  it("holds every function the contract names", () => {
    const required =
      "SUM AVERAGE MIN MAX COUNT COUNTA COUNTBLANK PRODUCT SUMPRODUCT SUMIF SUMIFS COUNTIF COUNTIFS AVERAGEIF AVERAGEIFS MEDIAN " +
      "IF IFS IFERROR IFNA AND OR NOT XOR TRUE FALSE SWITCH CHOOSE " +
      "ABS ROUND ROUNDUP ROUNDDOWN INT TRUNC MOD POWER SQRT EXP LN LOG LOG10 SIGN CEILING FLOOR PI RAND " +
      "VLOOKUP HLOOKUP XLOOKUP INDEX MATCH ROW COLUMN ROWS COLUMNS " +
      "CONCATENATE CONCAT TEXTJOIN LEFT RIGHT MID LEN TRIM UPPER LOWER PROPER FIND SEARCH SUBSTITUTE REPLACE REPT TEXT VALUE EXACT " +
      "DATE YEAR MONTH DAY WEEKDAY TODAY NOW EDATE EOMONTH DAYS DATEDIF " +
      "ISBLANK ISNUMBER ISTEXT ISLOGICAL ISERROR ISERR ISNA NA " +
      "PMT PV FV NPV IRR";
    const functions = createFunctionRegistry();
    expect(required.split(" ").filter((name) => !functions.has(name))).toEqual([]);
    expect(functions.names().length).toBeGreaterThanOrEqual(190);
    expect(createFunctionRegistry({ builtins: false }).names()).toEqual([]);
  });

  it("is what a workbook calculates with, TEXT and the number formats included", async () => {
    const workbook = await openXlsx(loadFixture("formulas.xlsx"));
    const calc = sheetId(workbook, "Calc");
    const set = (a1: string, formula: string): void => workbook.setFormula(calc, parseA1(a1), formula);
    set("F1", 'TEXT(B8,"#,##0.00")&" total"');
    set("F2", 'TEXT(DATE(2027,1,15),"d mmmm yyyy")');
    set("F3", "ROUND(B2,1)+LEN(B3)");
    set("F4", 'IFERROR(B10,"missing")');
    set("F5", 'COUNTIF(Data!D2:D6,">20")');
    set("F6", "XLOOKUP(\"SKU-003\",Data!A2:A6,Data!C2:C6)");
    set("F7", "TEXT(TODAY(),\"yyyy-mm-dd\")");
    set("F8", "NOTAFUNCTION(1)");
    workbook.recalc({ now: "2026-11-23T09:00:00Z" });
    const value = (a1: string): CellValue => workbook.getCell(calc, parseA1(a1)).value;
    expect(value("F1")).toBe("1,765.36 total");
    expect(value("F2")).toBe("15 January 2027");
    expect(value("F3")).toBe(9.6 + 3);
    expect(value("F4")).toBe("missing");
    expect(typeof value("F5")).toBe("number");
    expect(value("F6")).toBe(19.99);
    expect(value("F7")).toBe("2026-11-23");
    expect(value("F8")).toEqual({ kind: "error", code: "#NAME?" });
  });
});
