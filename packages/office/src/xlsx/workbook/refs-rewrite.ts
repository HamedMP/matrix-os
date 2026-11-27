/**
 * Rewrites the references of a formula when the sheet around it changes:
 * rows and columns inserted or deleted, a sheet renamed or removed, a shared
 * formula copied to another cell.
 */

import { MAX_COLS, MAX_ROWS, columnLabel, quoteSheetName } from "./a1.js";
import { type RefCorner, type RefToken, replaceRefs, scanRefs } from "./refs-scan.js";

export const REF_ERROR = "#REF!";

/** Rows or columns inserted (`count` above 0) or deleted (`count` below 0) from `index`. */
export interface StructuralOp {
  axis: "row" | "col";
  index: number;
  count: number;
}

/** Where a position moves to; -1 when it was deleted or pushed off the sheet. */
export function movePoint(position: number, op: StructuralOp): number {
  const limit = op.axis === "row" ? MAX_ROWS : MAX_COLS;
  if (op.count > 0) {
    const moved = position >= op.index ? position + op.count : position;
    return moved >= limit ? -1 : moved;
  }
  const removed = -op.count;
  if (position < op.index) return position;
  return position >= op.index + removed ? position - removed : -1;
}

/**
 * Where an inclusive span moves to, or null when nothing of it is left.
 * A span that reaches across inserted lines grows; one that loses lines shrinks.
 */
export function moveSpan(low: number, high: number, op: StructuralOp): { low: number; high: number } | null {
  const limit = op.axis === "row" ? MAX_ROWS : MAX_COLS;
  if (op.count > 0) {
    const newLow = low >= op.index ? low + op.count : low;
    const newHigh = high >= op.index ? high + op.count : high;
    if (newLow >= limit) return null;
    return { low: newLow, high: Math.min(newHigh, limit - 1) };
  }
  const removed = -op.count;
  const lastRemoved = op.index + removed - 1;
  const newLow = low < op.index ? low : low > lastRemoved ? low - removed : op.index;
  const newHigh = high < op.index ? high : high > lastRemoved ? high - removed : op.index - 1;
  return newLow > newHigh ? null : { low: newLow, high: newHigh };
}

function cornerText(corner: RefCorner, withCol: boolean, withRow: boolean): string {
  let text = "";
  if (withCol) text += (corner.colAbs ? "$" : "") + columnLabel(corner.col);
  if (withRow) text += (corner.rowAbs ? "$" : "") + String(corner.row + 1);
  return text;
}

/** The address part of a reference, without a sheet prefix. */
export function addressText(kind: RefToken["kind"], a: RefCorner, b: RefCorner): string {
  switch (kind) {
    case "cell":
      return cornerText(a, true, true);
    case "range":
      return `${cornerText(a, true, true)}:${cornerText(b, true, true)}`;
    case "cols":
      return `${cornerText(a, true, false)}:${cornerText(b, true, false)}`;
    case "rows":
      return `${cornerText(a, false, true)}:${cornerText(b, false, true)}`;
    case "name":
      return "";
  }
}

/** Applies a structural edit to one reference. Returns the new address, null for no change, or `#REF!`. */
function moveAddress(ref: RefToken, op: StructuralOp): string | null {
  const axis = op.axis;
  if (ref.kind === "name" || (ref.kind === "cols" && axis === "row") || (ref.kind === "rows" && axis === "col")) {
    return null;
  }
  const a = ref.a;
  const b = ref.b;
  if (ref.kind === "cell") {
    const position = axis === "row" ? a.row : a.col;
    const moved = movePoint(position, op);
    if (moved === position) return null;
    if (moved < 0) return REF_ERROR;
    const corner = axis === "row" ? { ...a, row: moved } : { ...a, col: moved };
    return addressText("cell", corner, corner);
  }
  const first = axis === "row" ? a.row : a.col;
  const second = axis === "row" ? b.row : b.col;
  const span = moveSpan(Math.min(first, second), Math.max(first, second), op);
  if (span === null) return REF_ERROR;
  const newFirst = first <= second ? span.low : span.high;
  const newSecond = first <= second ? span.high : span.low;
  if (newFirst === first && newSecond === second) return null;
  const na = axis === "row" ? { ...a, row: newFirst } : { ...a, col: newFirst };
  const nb = axis === "row" ? { ...b, row: newSecond } : { ...b, col: newSecond };
  return addressText(ref.kind, na, nb);
}

/**
 * Rewrites a formula after rows or columns were inserted or deleted on the
 * sheet named `sheetKey` (lower case). `ownSheet` tells whether the formula
 * itself is on that sheet, which decides what an unqualified reference means.
 */
export function rewriteForStructure(text: string, ownSheet: boolean, sheetKey: string, op: StructuralOp): string {
  const refs = scanRefs(text);
  if (refs.length === 0) return text;
  return replaceRefs(text, refs, (ref) => {
    if (ref.sheet === null ? !ownSheet : ref.sheet.toLowerCase() !== sheetKey) return null;
    const moved = moveAddress(ref, op);
    if (moved === null) return null;
    return moved === REF_ERROR ? REF_ERROR : text.slice(ref.start, ref.refStart) + moved;
  });
}

/** Rewrites every reference to the sheet `oldKey` (lower case) to use `newName`. */
export function rewriteForRename(text: string, oldKey: string, newName: string): string {
  const refs = scanRefs(text);
  if (refs.length === 0) return text;
  const prefix = `${quoteSheetName(newName)}!`;
  return replaceRefs(text, refs, (ref) =>
    ref.sheet !== null && ref.sheet.toLowerCase() === oldKey ? prefix + text.slice(ref.refStart, ref.end) : null,
  );
}

/** Turns every reference to the sheet `sheetKey` (lower case) into `#REF!`. */
export function rewriteForRemoval(text: string, sheetKey: string): string {
  const refs = scanRefs(text);
  if (refs.length === 0) return text;
  return replaceRefs(text, refs, (ref) => (ref.sheet !== null && ref.sheet.toLowerCase() === sheetKey ? REF_ERROR : null));
}

function shiftCorner(corner: RefCorner, rows: number, cols: number): RefCorner | null {
  const row = corner.rowAbs ? corner.row : corner.row + rows;
  const col = corner.colAbs ? corner.col : corner.col + cols;
  if (row < 0 || row >= MAX_ROWS || col < 0 || col >= MAX_COLS) return null;
  return { row, col, rowAbs: corner.rowAbs, colAbs: corner.colAbs };
}

/**
 * The formula as it reads when copied `rows` down and `cols` to the right:
 * relative references move, absolute ones (`$`) stay. A reference that would
 * leave the sheet becomes `#REF!`.
 */
export function shiftRelativeRefs(text: string, rows: number, cols: number): string {
  if (rows === 0 && cols === 0) return text;
  const refs = scanRefs(text);
  if (refs.length === 0) return text;
  return replaceRefs(text, refs, (ref) => {
    if (ref.kind === "name") return null;
    const dr = ref.kind === "cols" ? 0 : rows;
    const dc = ref.kind === "rows" ? 0 : cols;
    const a = shiftCorner(ref.a, dr, dc);
    const b = shiftCorner(ref.b, dr, dc);
    if (a === null || b === null) return REF_ERROR;
    return text.slice(ref.start, ref.refStart) + addressText(ref.kind, a, b);
  });
}

/** True when the formula has a reference to the sheet `sheetKey` (lower case). */
export function refersToSheet(text: string, sheetKey: string): boolean {
  for (const ref of scanRefs(text)) if (ref.sheet !== null && ref.sheet.toLowerCase() === sheetKey) return true;
  return false;
}
