/**
 * Rewriting the references of a formula when the sheet around it changes.
 *
 * Two kinds of rewrite:
 *
 * - {@link rewriteReferences}: rows, columns, cells or sheets were inserted,
 *   deleted, moved or renamed. Every reference to the changed sheet follows
 *   its cells, whether it is written with `$` or not, and a reference whose
 *   cells are gone becomes `#REF!`.
 * - {@link shiftReferences}: the formula itself was copied or filled to
 *   another cell. The parts written without `$` move by the same distance,
 *   and a reference pushed off the sheet becomes `#REF!`.
 *
 * Both return the tree they were given when nothing changed.
 * {@link rewriteFormulaText} and {@link shiftFormulaText} do the same from
 * text to text and accept the full grammar.
 */

import type { CellCorner, CellNode, ErrorNode, FormulaAst, RangeBounds, RangeNode } from "../../../api/formula.js";
import { inSheet, normalizeCorners, sameSheet } from "./a1.js";
import { MAX_COL, MAX_ROW, type ExtendedAst, type SheetSpanNode } from "./ast.js";
import { parseFormulaExtended } from "./parser.js";
import { serializeFormula } from "./serialize.js";
import { transformNodes } from "./walk.js";

/**
 * A change to the structure of a workbook.
 *
 * - `insertRows` / `insertColumns`: `count` new rows or columns before `index`.
 * - `deleteRows` / `deleteColumns`: `count` rows or columns from `index` on are removed.
 * - `moveRows` / `moveColumns`: the `count` rows or columns starting at
 *   `from` are moved so that the first of them ends up at `to`. Each end
 *   of a range follows its own row or column.
 * - `moveCells`: the rectangle `from` is cut and pasted with its top-left
 *   cell at (`toRow`, `toCol`) on `toSheet` (default: the same sheet).
 *   References to the cells that moved follow them; references to cells the
 *   paste overwrote become `#REF!`.
 * - `renameSheet`, `deleteSheet`.
 *
 * Indexes are zero-based.
 */
export type ReferenceChange =
  | { kind: "insertRows" | "deleteRows" | "insertColumns" | "deleteColumns"; sheet: string; index: number; count: number }
  | { kind: "moveRows" | "moveColumns"; sheet: string; from: number; count: number; to: number }
  | { kind: "moveCells"; from: RangeBounds; toRow: number; toCol: number; toSheet?: string }
  | { kind: "renameSheet"; from: string; to: string }
  | { kind: "deleteSheet"; sheet: string };

const REF_ERROR: ErrorNode = { type: "error", code: "#REF!" };

/** Where an inclusive span of rows or columns ends up, or null when all of it is gone. */
type SpanMap = (start: number, end: number) => { start: number; end: number } | null;

function insertSpan(index: number, count: number, max: number): SpanMap {
  return (start, end) => {
    const a = start >= index ? start + count : start;
    const b = end >= index ? end + count : end;
    return a > max ? null : { start: a, end: Math.min(b, max) };
  };
}

function deleteSpan(index: number, count: number): SpanMap {
  const last = index + count - 1;
  return (start, end) => {
    if (start >= index && end <= last) return null;
    const a = start < index ? start : start > last ? start - count : index;
    const b = end < index ? end : end > last ? end - count : index - 1;
    return { start: a, end: b };
  };
}

function moveSpan(from: number, count: number, to: number): SpanMap {
  const point = (p: number): number => {
    if (p >= from && p < from + count) return to + (p - from);
    const closed = p >= from + count ? p - count : p;
    return closed >= to ? closed + count : closed;
  };
  return (start, end) => {
    const a = point(start);
    const b = point(end);
    return a <= b ? { start: a, end: b } : { start: b, end: a };
  };
}

function withSpan(node: CellNode | RangeNode, axis: "row" | "col", map: SpanMap): CellNode | RangeNode | ErrorNode {
  if (node.type === "cell") {
    const mapped = map(node[axis], node[axis]);
    if (mapped === null) return REF_ERROR;
    return mapped.start === node[axis] ? node : { ...node, [axis]: mapped.start };
  }
  if ((node.shape === "columns" && axis === "row") || (node.shape === "rows" && axis === "col")) return node;
  const mapped = map(node.start[axis], node.end[axis]);
  if (mapped === null) return REF_ERROR;
  if (mapped.start === node.start[axis] && mapped.end === node.end[axis]) return node;
  return { ...node, start: { ...node.start, [axis]: mapped.start }, end: { ...node.end, [axis]: mapped.end } };
}

function boundsOf(node: CellNode | RangeNode): { startRow: number; startCol: number; endRow: number; endCol: number } {
  if (node.type === "cell") return { startRow: node.row, startCol: node.col, endRow: node.row, endCol: node.col };
  return { startRow: node.start.row, startCol: node.start.col, endRow: node.end.row, endCol: node.end.col };
}

function inside(inner: ReturnType<typeof boundsOf>, outer: ReturnType<typeof boundsOf>): boolean {
  return (
    inner.startRow >= outer.startRow &&
    inner.endRow <= outer.endRow &&
    inner.startCol >= outer.startCol &&
    inner.endCol <= outer.endCol
  );
}

function translate(node: CellNode | RangeNode, rows: number, cols: number): CellNode | RangeNode {
  if (node.type === "cell") return { ...node, row: node.row + rows, col: node.col + cols };
  return {
    ...node,
    start: { ...node.start, row: node.start.row + rows, col: node.start.col + cols },
    end: { ...node.end, row: node.end.row + rows, col: node.end.col + cols },
  };
}

interface Rewriter {
  /** The sheet the formula is on before the change, for references without a sheet. */
  homeBefore: string;
  /** The sheet the formula is on after the change. */
  homeAfter: string;
}

/** Writes the sheet of a reference so that it still means `target` from the formula's new sheet. */
function retarget<T extends CellNode | RangeNode>(node: T, target: string, ctx: Rewriter): T {
  if (node.sheet === null) return sameSheet(target, ctx.homeAfter) ? node : { ...node, sheet: target };
  return sameSheet(node.sheet, target) ? node : { ...node, sheet: target };
}

function rewriteReference(node: CellNode | RangeNode, change: ReferenceChange, ctx: Rewriter): ExtendedAst {
  const sheet = node.sheet ?? ctx.homeBefore;
  switch (change.kind) {
    case "insertRows":
      return sameSheet(sheet, change.sheet) ? withSpan(node, "row", insertSpan(change.index, change.count, MAX_ROW)) : node;
    case "insertColumns":
      return sameSheet(sheet, change.sheet) ? withSpan(node, "col", insertSpan(change.index, change.count, MAX_COL)) : node;
    case "deleteRows":
      return sameSheet(sheet, change.sheet) ? withSpan(node, "row", deleteSpan(change.index, change.count)) : node;
    case "deleteColumns":
      return sameSheet(sheet, change.sheet) ? withSpan(node, "col", deleteSpan(change.index, change.count)) : node;
    case "moveRows":
      return sameSheet(sheet, change.sheet) ? withSpan(node, "row", moveSpan(change.from, change.count, change.to)) : node;
    case "moveColumns":
      return sameSheet(sheet, change.sheet) ? withSpan(node, "col", moveSpan(change.from, change.count, change.to)) : node;
    case "renameSheet":
      return node.sheet !== null && sameSheet(node.sheet, change.from) ? { ...node, sheet: change.to } : node;
    case "deleteSheet":
      return node.sheet !== null && sameSheet(node.sheet, change.sheet) ? REF_ERROR : node;
    case "moveCells": {
      const toSheet = change.toSheet ?? change.from.sheet;
      const bounds = boundsOf(node);
      if (sameSheet(sheet, change.from.sheet) && inside(bounds, change.from)) {
        const moved = translate(node, change.toRow - change.from.startRow, change.toCol - change.from.startCol);
        const after = boundsOf(moved);
        if (!inSheet(after.startRow, after.startCol) || !inSheet(after.endRow, after.endCol)) return REF_ERROR;
        return retarget(moved, toSheet, ctx);
      }
      const destination = {
        startRow: change.toRow,
        startCol: change.toCol,
        endRow: change.toRow + (change.from.endRow - change.from.startRow),
        endCol: change.toCol + (change.from.endCol - change.from.startCol),
      };
      if (sameSheet(sheet, toSheet) && inside(bounds, destination)) return REF_ERROR;
      return retarget(node, sheet, ctx);
    }
  }
}

function rewriteSpan(node: SheetSpanNode, change: ReferenceChange): ExtendedAst {
  if (change.kind === "renameSheet") {
    const startSheet = sameSheet(node.startSheet, change.from) ? change.to : node.startSheet;
    const endSheet = sameSheet(node.endSheet, change.from) ? change.to : node.endSheet;
    return startSheet === node.startSheet && endSheet === node.endSheet ? node : { ...node, startSheet, endSheet };
  }
  if (change.kind === "deleteSheet") {
    return sameSheet(node.startSheet, change.sheet) || sameSheet(node.endSheet, change.sheet) ? REF_ERROR : node;
  }
  return node;
}

/**
 * Rewrites the references of a formula after a structural change.
 *
 * `formulaSheet` is the sheet the formula is on; references without a sheet
 * name belong to it. Pass `formulaSheetAfter` when a `moveCells` change
 * carried the formula itself to another sheet, so that its references keep
 * pointing at the cells they pointed at.
 *
 * A defined name is not changed here: rewrite the formula the name stands
 * for with the same call. A reference across a span of sheets follows a
 * sheet rename or removal only.
 */
export function rewriteReferences(
  ast: FormulaAst,
  change: ReferenceChange,
  formulaSheet: string,
  formulaSheetAfter?: string,
): FormulaAst;
export function rewriteReferences(
  ast: ExtendedAst,
  change: ReferenceChange,
  formulaSheet: string,
  formulaSheetAfter?: string,
): ExtendedAst;
export function rewriteReferences(
  ast: ExtendedAst,
  change: ReferenceChange,
  formulaSheet: string,
  formulaSheetAfter: string = formulaSheet,
): ExtendedAst {
  const ctx: Rewriter = { homeBefore: formulaSheet, homeAfter: formulaSheetAfter };
  return transformNodes(ast, (node) => {
    if (node.type === "cell" || node.type === "range") return rewriteReference(node, change, ctx);
    if (node.type === "ref3d") return rewriteSpan(node, change);
    if (node.type === "name" && node.sheet !== null) {
      if (change.kind === "renameSheet" && sameSheet(node.sheet, change.from)) return { ...node, sheet: change.to };
      if (change.kind === "deleteSheet" && sameSheet(node.sheet, change.sheet)) return REF_ERROR;
    }
    return null;
  });
}

function shiftCorner(corner: CellCorner, rows: number, cols: number): CellCorner {
  const row = corner.rowAbsolute ? corner.row : corner.row + rows;
  const col = corner.colAbsolute ? corner.col : corner.col + cols;
  return row === corner.row && col === corner.col ? corner : { ...corner, row, col };
}

function shiftReference(node: CellNode | RangeNode, rows: number, cols: number): CellNode | RangeNode | ErrorNode {
  if (node.type === "cell") {
    const moved = shiftCorner(node, rows, cols);
    if (moved === node) return node;
    return inSheet(moved.row, moved.col) ? { ...node, row: moved.row, col: moved.col } : REF_ERROR;
  }
  const start = shiftCorner(node.start, rows, cols);
  const end = shiftCorner(node.end, rows, cols);
  if (start === node.start && end === node.end) return node;
  if (!inSheet(start.row, start.col) || !inSheet(end.row, end.col)) return REF_ERROR;
  return { ...node, ...normalizeCorners(start, end) };
}

/**
 * Adjusts a formula that was copied or filled `rowDelta` rows down and
 * `colDelta` columns to the right (negative for up and left): `A1` becomes
 * `B3` for (2, 1), `$A1` becomes `$A3`, `$A$1` stays. A whole-column range
 * moves sideways only and a whole-row range up and down only.
 */
export function shiftReferences(ast: FormulaAst, rowDelta: number, colDelta: number): FormulaAst;
export function shiftReferences(ast: ExtendedAst, rowDelta: number, colDelta: number): ExtendedAst;
export function shiftReferences(ast: ExtendedAst, rowDelta: number, colDelta: number): ExtendedAst {
  if (rowDelta === 0 && colDelta === 0) return ast;
  return transformNodes(ast, (node) => {
    if (node.type === "cell" || node.type === "range") return shiftReference(node, rowDelta, colDelta);
    if (node.type === "ref3d") {
      const ref = shiftReference(node.ref, rowDelta, colDelta);
      if (ref === node.ref) return node;
      return ref.type === "error" ? ref : { ...node, ref };
    }
    return null;
  });
}

/** {@link rewriteReferences} from formula text to formula text (no leading `=` in the result). Throws `formula_error` for text that does not parse. */
export function rewriteFormulaText(
  text: string,
  change: ReferenceChange,
  formulaSheet: string,
  formulaSheetAfter?: string,
): string {
  const ast = parseFormulaExtended(text);
  return serializeFormula(rewriteReferences(ast, change, formulaSheet, formulaSheetAfter));
}

/** {@link shiftReferences} from formula text to formula text (no leading `=` in the result). Throws `formula_error` for text that does not parse. */
export function shiftFormulaText(text: string, rowDelta: number, colDelta: number): string {
  return serializeFormula(shiftReferences(parseFormulaExtended(text), rowDelta, colDelta));
}
