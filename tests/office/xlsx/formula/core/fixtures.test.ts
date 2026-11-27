// Runs the formula engine over the committed workbooks: every formula parses and writes
// back unchanged, and a full recalculation through the dependency graph reproduces the
// values the files cache. Formulas that need a function that is not registered keep
// their cached value, so the check widens by itself as function libraries land.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { CellProvider, FormulaAst, FormulaScalar } from "../../../../../packages/office/src/api/formula.js";
import {
  CIRCULAR_REFERENCE,
  DependencyGraph,
  collectFunctionNames,
  collectReferences,
  createFunctionRegistry,
  evaluateCell,
  parseFormula,
  serializeFormula,
} from "../../../../../packages/office/src/xlsx/formula/index.js";
import { child, findAll, getAttr, parseXml, textContent } from "../../../../../packages/office/src/xml/index.js";
import { address } from "./helpers.js";

const FIXTURES = join(__dirname, "..", "..", "..", "fixtures");
const WORKBOOKS = ["basic", "formulas", "formats", "multi-sheet", "model"];

interface LoadedCell {
  value: FormulaScalar;
  formula: string | null;
}

interface LoadedWorkbook {
  sheets: Map<string, Map<string, LoadedCell>>;
  names: Record<string, string>;
}

function load(stem: string): LoadedWorkbook {
  const parts = unzipSync(new Uint8Array(readFileSync(join(FIXTURES, `${stem}.xlsx`))));
  const xml = (name: string) => parseXml(strFromU8(parts[name] as Uint8Array));
  const strings = parts["xl/sharedStrings.xml"] === undefined
    ? []
    : findAll(xml("xl/sharedStrings.xml"), "si").map((si) => findAll(si, "t").map(textContent).join(""));
  const targets = new Map<string, string>();
  for (const rel of findAll(xml("xl/_rels/workbook.xml.rels"), "Relationship")) {
    targets.set(getAttr(rel, "Id") as string, (getAttr(rel, "Target") as string).replace(/^\/?(xl\/)?/, "xl/"));
  }
  const workbook = xml("xl/workbook.xml");
  const sheets = new Map<string, Map<string, LoadedCell>>();
  for (const sheet of findAll(workbook, "sheet")) {
    const cells = new Map<string, LoadedCell>();
    for (const c of findAll(xml(targets.get(getAttr(sheet, "r:id") as string) as string), "c")) {
      const type = getAttr(c, "t") ?? "n";
      const f = child(c, "f");
      const v = child(c, "v");
      const raw = v === null ? null : textContent(v);
      let value: FormulaScalar = null;
      if (type === "inlineStr") value = findAll(c, "t").map(textContent).join("");
      else if (raw === null) value = null;
      else if (type === "s") value = strings[Number(raw)] as string;
      else if (type === "str") value = raw;
      else if (type === "b") value = raw === "1";
      else if (type === "e") value = { kind: "error", code: raw as "#N/A" };
      else value = Number(raw);
      const formula = f === null ? null : textContent(f);
      cells.set(getAttr(c, "r") as string, { value, formula: formula === "" ? null : formula });
    }
    sheets.set(getAttr(sheet, "name") as string, cells);
  }
  const summary = JSON.parse(readFileSync(join(FIXTURES, "expected", `${stem}.xlsx.summary.json`), "utf8")) as {
    definedNames: Record<string, string>;
  };
  return { sheets, names: summary.definedNames };
}

const a1 = (row: number, col: number): string => {
  let label = "";
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) label = String.fromCharCode(65 + ((n - 1) % 26)) + label;
  return `${label}${row + 1}`;
};

function provider(book: LoadedWorkbook): CellProvider {
  const find = (sheet: string) => {
    for (const [name, cells] of book.sheets) if (name.toUpperCase() === sheet.toUpperCase()) return cells;
    return null;
  };
  return {
    getCellValue(sheet, row, col) {
      const cells = find(sheet);
      return cells === null ? { kind: "error", code: "#REF!" } : (cells.get(a1(row, col))?.value ?? null);
    },
    getRangeValues(bounds) {
      const cells = find(bounds.sheet);
      if (cells === null) return { kind: "error", code: "#REF!" };
      let lastRow = -1;
      let lastCol = -1;
      for (const key of cells.keys()) {
        const at = address(key);
        lastRow = Math.max(lastRow, at.row);
        lastCol = Math.max(lastCol, at.col);
      }
      const rows: FormulaScalar[][] = [];
      for (let row = bounds.startRow; row <= Math.min(bounds.endRow, lastRow); row += 1) {
        const line: FormulaScalar[] = [];
        for (let col = bounds.startCol; col <= Math.min(bounds.endCol, lastCol); col += 1) line.push(cells.get(a1(row, col))?.value ?? null);
        rows.push(line);
      }
      return rows;
    },
    resolveName(name) {
      const text = Object.entries(book.names).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1];
      return text === undefined ? null : { kind: "formula", ast: parseFormula(text), sheet: [...book.sheets.keys()][0] as string };
    },
  };
}

describe.each(WORKBOOKS)("%s.xlsx", (stem) => {
  const book = load(stem);
  const formulas: Array<{ sheet: string; cell: string; text: string; ast: FormulaAst }> = [];
  for (const [sheet, cells] of book.sheets) {
    for (const [cell, content] of cells) {
      if (content.formula !== null) formulas.push({ sheet, cell, text: content.formula, ast: parseFormula(content.formula) });
    }
  }

  it("parses every formula and writes it back unchanged", () => {
    for (const { text, ast } of formulas) {
      const written = serializeFormula(ast);
      expect(written).toBe(text);
      expect(parseFormula(written)).toEqual(ast);
      expect(Array.isArray(collectReferences(ast))).toBe(true);
    }
    for (const text of Object.values(book.names)) expect(serializeFormula(parseFormula(text))).toBe(text);
  });

  it("recalculates to the values cached in the file", () => {
    const functions = createFunctionRegistry();
    const cells = provider(book);
    const graph = new DependencyGraph({ functions, resolveName: (name, sheet) => cells.resolveName(name, sheet) });
    const cached = new Map<string, FormulaScalar>();
    const byCell = new Map<string, FormulaAst>();
    // A formula is checked when every function it calls is registered; the others keep the cached value.
    for (const { sheet, cell, ast } of formulas) {
      if (!collectFunctionNames(ast).every((name) => functions.has(name))) continue;
      const content = book.sheets.get(sheet)?.get(cell) as LoadedCell;
      cached.set(`${sheet}!${cell}`, content.value);
      byCell.set(`${sheet}!${cell}`, ast);
      content.value = "not calculated";
      const at = address(cell);
      graph.setFormula(sheet, at.row, at.col, ast);
    }
    const result = graph.recalculate({
      compute: (at) => {
        const key = `${at.sheet}!${a1(at.row, at.col)}`;
        const value = evaluateCell(byCell.get(key) as FormulaAst, { provider: cells, functions, sheet: at.sheet, row: at.row, col: at.col });
        (book.sheets.get(at.sheet)?.get(a1(at.row, at.col)) as LoadedCell).value = value;
      },
      circular: (at) => {
        (book.sheets.get(at.sheet)?.get(a1(at.row, at.col)) as LoadedCell).value = CIRCULAR_REFERENCE;
      },
    });
    expect(result).toMatchObject({ computed: byCell.size, circular: [], complete: true });
    for (const [key, expected] of cached) {
      const [sheet, cell] = key.split("!") as [string, string];
      const actual = book.sheets.get(sheet)?.get(cell)?.value;
      if (typeof expected === "number") expect(actual, key).toBeCloseTo(expected, 6);
      else expect(actual, key).toEqual(expected);
    }
  });
});

describe("fixture coverage", () => {
  it("checks a meaningful number of formulas with the core functions alone", () => {
    const functions = createFunctionRegistry({ builtins: false });
    for (const name of ["SUM", "IF", "IFERROR", "AND", "OR", "NOT"]) functions.register(name, () => 0);
    let total = 0;
    let covered = 0;
    for (const stem of WORKBOOKS) {
      for (const cells of load(stem).sheets.values()) {
        for (const content of cells.values()) {
          if (content.formula === null) continue;
          total += 1;
          if (collectFunctionNames(parseFormula(content.formula)).every((name) => functions.has(name))) covered += 1;
        }
      }
    }
    expect(total).toBe(123);
    expect(covered).toBeGreaterThanOrEqual(100);
  });
});
