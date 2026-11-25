/**
 * Tracing a value back to its sources. The walk is done here, in code, with
 * the engine's precedent lists; the model only narrates the result.
 */

import { type CellAddress, type CellRange, type SheetCellRef, type SheetId, type Workbook, formatA1, formatA1Range, isOfficeError } from "./engine";
import { MAX_HIGHLIGHTS, MAX_TRACE_DEPTH, MAX_TRACE_NODES, MAX_TRACE_RANGE_CELLS } from "./limits";

export type TraceNodeKind =
  /** A formula cell; `children` are what it reads. */
  | "formula"
  /** A typed-in value: a source of the traced number. */
  | "input"
  | "empty"
  /** A range a formula reads; `children` are its cells (at most `MAX_TRACE_RANGE_CELLS`). */
  | "range"
  /** A cell already shown higher up in the trace. */
  | "repeat";

export interface TraceNode {
  kind: TraceNodeKind;
  sheet: SheetId;
  /** `Sheet!A1` or `Sheet!A1:B9`. */
  location: string;
  row: number;
  col: number;
  display: string;
  formula: string | null;
  children: TraceNode[];
  /** Cells of a range that were not expanded, or formula sources not followed because a bound was reached. */
  omitted: number;
}

export interface Trace {
  root: TraceNode;
  nodeCount: number;
  /** True when a bound stopped the walk somewhere. */
  truncated: boolean;
  /** The typed-in values the traced cell depends on, each once. */
  inputs: TraceNode[];
  /** Every cell visited, for highlighting on the grid (bounded). */
  cells: SheetCellRef[];
}

export interface TraceLimits {
  maxNodes?: number;
  maxDepth?: number;
  maxRangeCells?: number;
}

interface Walk {
  workbook: Workbook;
  names: Map<SheetId, string>;
  seen: Set<string>;
  nodes: number;
  truncated: boolean;
  inputs: TraceNode[];
  cells: SheetCellRef[];
  maxNodes: number;
  maxDepth: number;
  maxRangeCells: number;
}

function keyOf(sheet: SheetId, row: number, col: number): string {
  return `${sheet}|${row}|${col}`;
}

function nameOf(walk: Walk, sheet: SheetId): string {
  let name = walk.names.get(sheet);
  if (name === undefined) {
    try {
      name = walk.workbook.getSheet(sheet).name;
    } catch (error: unknown) {
      if (!isOfficeError(error)) throw error;
      name = "?";
    }
    walk.names.set(sheet, name);
  }
  return name;
}

function cellNode(walk: Walk, sheet: SheetId, address: CellAddress, depth: number): TraceNode {
  walk.nodes += 1;
  const location = `${nameOf(walk, sheet)}!${formatA1(address)}`;
  const key = keyOf(sheet, address.row, address.col);
  const cell = walk.workbook.getCell(sheet, address);
  const base = { sheet, location, row: address.row, col: address.col, display: cell.display, formula: cell.formula, children: [] as TraceNode[], omitted: 0 };
  if (walk.seen.has(key)) return { ...base, kind: "repeat" };
  walk.seen.add(key);
  if (walk.cells.length < MAX_HIGHLIGHTS) walk.cells.push({ sheet, row: address.row, col: address.col });
  if (cell.formula === null) {
    const node: TraceNode = { ...base, kind: cell.value === null ? "empty" : "input" };
    if (node.kind === "input") walk.inputs.push(node);
    return node;
  }
  const node: TraceNode = { ...base, kind: "formula" };
  const sources = walk.workbook.precedents(sheet, address);
  for (const source of sources) {
    if (depth + 1 > walk.maxDepth || walk.nodes >= walk.maxNodes) {
      node.omitted += 1;
      walk.truncated = true;
      continue;
    }
    node.children.push(sourceNode(walk, source.sheet, source, depth + 1));
  }
  return node;
}

function sourceNode(walk: Walk, sheet: SheetId, range: CellRange, depth: number): TraceNode {
  const single = range.start.row === range.end.row && range.start.col === range.end.col;
  if (single) return cellNode(walk, sheet, range.start, depth);
  walk.nodes += 1;
  const node: TraceNode = {
    kind: "range",
    sheet,
    location: `${nameOf(walk, sheet)}!${formatA1Range(range)}`,
    row: range.start.row,
    col: range.start.col,
    display: "",
    formula: null,
    children: [],
    omitted: 0,
  };
  // Only cells that hold something are sources; the used part of the sheet bounds the scan.
  const used = walk.workbook.getSheet(sheet).dimensions;
  if (used === null) return node;
  const top = Math.max(range.start.row, used.start.row);
  const bottom = Math.min(range.end.row, used.end.row);
  const left = Math.max(range.start.col, used.start.col);
  const right = Math.min(range.end.col, used.end.col);
  for (let row = top; row <= bottom; row++) {
    for (let col = left; col <= right; col++) {
      const cell = walk.workbook.getCell(sheet, { row, col });
      if (cell.value === null && cell.formula === null) continue;
      if (node.children.length >= walk.maxRangeCells || depth + 1 > walk.maxDepth || walk.nodes >= walk.maxNodes) {
        node.omitted += 1;
        walk.truncated = true;
        continue;
      }
      node.children.push(cellNode(walk, sheet, { row, col }, depth + 1));
    }
  }
  return node;
}

/** Walks the precedents of a cell, depth first, each cell once. */
export function traceValue(workbook: Workbook, sheet: SheetId, address: CellAddress, limits: TraceLimits = {}): Trace {
  const walk: Walk = {
    workbook,
    names: new Map(),
    seen: new Set(),
    nodes: 0,
    truncated: false,
    inputs: [],
    cells: [],
    maxNodes: limits.maxNodes ?? MAX_TRACE_NODES,
    maxDepth: limits.maxDepth ?? MAX_TRACE_DEPTH,
    maxRangeCells: limits.maxRangeCells ?? MAX_TRACE_RANGE_CELLS,
  };
  const root = cellNode(walk, sheet, address, 0);
  return { root, nodeCount: walk.nodes, truncated: walk.truncated, inputs: walk.inputs, cells: walk.cells };
}

function line(node: TraceNode): string {
  switch (node.kind) {
    case "formula":
      return `${node.location} = ${node.formula ?? ""} → ${node.display}`;
    case "input":
      return `${node.location}: ${node.display} (typed-in input)`;
    case "empty":
      return `${node.location}: empty`;
    case "range":
      return `${node.location} (range)`;
    case "repeat":
      return `${node.location} (shown above)`;
  }
}

/**
 * The trace as indented lines, at most `maxChars` long. Cell text appears in
 * it, so callers wrap it as untrusted content before a model sees it.
 */
export function traceText(trace: Trace, maxChars = 12_000): string {
  const lines: string[] = [];
  let length = 0;
  let cut = false;
  const visit = (node: TraceNode, depth: number): void => {
    if (cut) return;
    const text = `${"  ".repeat(depth)}${line(node).replace(/[\r\n]+/g, " ")}${node.omitted > 0 ? ` (+${node.omitted} more not followed)` : ""}`;
    if (length + text.length + 1 > maxChars) {
      cut = true;
      return;
    }
    lines.push(text);
    length += text.length + 1;
    for (const child of node.children) visit(child, depth + 1);
  };
  visit(trace.root, 0);
  if (cut) lines.push("… (trace shortened)");
  return lines.join("\n");
}

/** Cells read directly by the formulas of a range, for highlighting (bounded). */
export function directPrecedents(workbook: Workbook, sheet: SheetId, range: CellRange): SheetCellRef[] {
  const out: SheetCellRef[] = [];
  const seen = new Set<string>();
  const used = workbook.getSheet(sheet).dimensions;
  if (used === null) return out;
  for (let row = Math.max(range.start.row, used.start.row); row <= Math.min(range.end.row, used.end.row); row++) {
    for (let col = Math.max(range.start.col, used.start.col); col <= Math.min(range.end.col, used.end.col); col++) {
      for (const source of workbook.precedents(sheet, { row, col })) {
        const info = workbook.getSheet(source.sheet).dimensions;
        if (info === null) continue;
        for (let r = Math.max(source.start.row, info.start.row); r <= Math.min(source.end.row, info.end.row); r++) {
          for (let c = Math.max(source.start.col, info.start.col); c <= Math.min(source.end.col, info.end.col); c++) {
            const key = keyOf(source.sheet, r, c);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ sheet: source.sheet, row: r, col: c });
            if (out.length >= MAX_HIGHLIGHTS) return out;
          }
        }
      }
    }
  }
  return out;
}
