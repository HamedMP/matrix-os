import type {
  CellProvider,
  FormulaError,
  FormulaScalar,
  FormulaValue,
  NameResolution,
  RangeBounds,
} from "../../../../../packages/office/src/api/formula.js";
import { parseFormula } from "../../../../../packages/office/src/xlsx/formula/parser/index.js";

export type SheetData = Record<string, FormulaScalar>;

export interface TestProvider extends CellProvider {
  /** Sets a cell by its A1 address. */
  set(sheet: string, address: string, value: FormulaScalar): void;
  /** Reads a cell by its A1 address. */
  get(sheet: string, address: string): FormulaScalar;
  /** Every call of `getCellValue` and `getRangeValues`, as `Sheet!r,c` or `Sheet!r,c:r,c`. */
  reads: string[];
}

export function address(text: string): { row: number; col: number } {
  const match = /^([A-Z]+)(\d+)$/.exec(text);
  if (match === null) throw new Error(`bad address ${text}`);
  let col = 0;
  for (const ch of match[1] as string) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(match[2]) - 1, col: col - 1 };
}

const REF: FormulaError = { kind: "error", code: "#REF!" };

/**
 * A small workbook for tests. `names` maps a defined name to formula text
 * (evaluated on `nameSheet`, default the first sheet) or to a value.
 */
export function makeProvider(
  sheets: Record<string, SheetData>,
  names: Record<string, string | { value: FormulaValue }> = {},
  nameSheet?: string,
): TestProvider {
  const data = new Map<string, Map<string, FormulaScalar>>();
  const display = new Map<string, string>();
  for (const [sheet, cells] of Object.entries(sheets)) {
    const map = new Map<string, FormulaScalar>();
    for (const [a1, value] of Object.entries(cells)) {
      const { row, col } = address(a1);
      map.set(`${row},${col}`, value);
    }
    data.set(sheet.toUpperCase(), map);
    display.set(sheet.toUpperCase(), sheet);
  }
  const home = nameSheet ?? Object.keys(sheets)[0] ?? "Sheet1";
  const reads: string[] = [];
  const used = (cells: Map<string, FormulaScalar>): { rows: number; cols: number } => {
    let rows = 0;
    let cols = 0;
    for (const key of cells.keys()) {
      const [r, c] = key.split(",").map(Number) as [number, number];
      rows = Math.max(rows, r + 1);
      cols = Math.max(cols, c + 1);
    }
    return { rows, cols };
  };
  return {
    reads,
    set(sheet, a1, value) {
      const { row, col } = address(a1);
      data.get(sheet.toUpperCase())?.set(`${row},${col}`, value);
    },
    get(sheet, a1) {
      const { row, col } = address(a1);
      return data.get(sheet.toUpperCase())?.get(`${row},${col}`) ?? null;
    },
    getCellValue(sheet, row, col) {
      reads.push(`${sheet}!${row},${col}`);
      const cells = data.get(sheet.toUpperCase());
      if (cells === undefined) return REF;
      return cells.get(`${row},${col}`) ?? null;
    },
    getRangeValues(bounds: RangeBounds) {
      reads.push(`${bounds.sheet}!${bounds.startRow},${bounds.startCol}:${bounds.endRow},${bounds.endCol}`);
      const cells = data.get(bounds.sheet.toUpperCase());
      if (cells === undefined) return REF;
      const size = used(cells);
      const endRow = Math.min(bounds.endRow, size.rows - 1);
      const endCol = Math.min(bounds.endCol, size.cols - 1);
      const out: FormulaScalar[][] = [];
      if (endCol < bounds.startCol) return out;
      for (let row = bounds.startRow; row <= endRow; row += 1) {
        const line: FormulaScalar[] = [];
        for (let col = bounds.startCol; col <= endCol; col += 1) line.push(cells.get(`${row},${col}`) ?? null);
        out.push(line);
      }
      return out;
    },
    resolveName(name, sheet): NameResolution | null {
      const scoped = names[`${sheet}!${name}`] ?? names[`${sheet.toUpperCase()}!${name.toUpperCase()}`];
      const found = scoped ?? names[name] ?? names[name.toUpperCase()];
      if (found === undefined) return null;
      if (typeof found === "string") return { kind: "formula", ast: parseFormula(found), sheet: home };
      return { kind: "value", value: found.value };
    },
  };
}
