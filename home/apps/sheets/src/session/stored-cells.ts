/**
 * The cells a sheet stores, found without reading every position.
 *
 * A sheet's used area can be mostly empty: values at `A1` and `XFD1048576`
 * make a used area of seventeen billion positions with two cells in it.
 * Reading each position of a band of rows or columns then freezes the page.
 * This walks the sheet's own rows and cells instead (the worksheet XML the
 * engine keeps in step with its cells), so the cost follows what the sheet
 * holds, not how far apart it lies. Asking for that XML first writes pending
 * cell edits into it, as saving does; the cells themselves do not change.
 */

import type { CellRange, SheetId, WorkbookInternals } from "./engine";

type XmlDoc = NonNullable<ReturnType<WorkbookInternals["getPartXml"]>>;
type XmlEl = XmlDoc["root"];

function named(node: { kind: string; name?: string }, local: string): boolean {
  if (node.kind !== "element" || node.name === undefined) return false;
  const colon = node.name.indexOf(":");
  return (colon < 0 ? node.name : node.name.slice(colon + 1)) === local;
}

function attr(element: XmlEl, name: string): string | null {
  for (const entry of element.attrs) if (entry.name === name) return entry.value;
  return null;
}

/** Zero-based column of a cell reference such as `AB12`, or -1 when it has no column letters. */
function columnOf(ref: string): number {
  let col = 0;
  let letters = 0;
  for (let i = 0; i < ref.length; i++) {
    const code = ref.charCodeAt(i) & ~32;
    if (code < 65 || code > 90) break;
    col = col * 26 + (code - 64);
    letters++;
  }
  return letters === 0 ? -1 : col - 1;
}

/**
 * Calls `visit` with the position of every cell the sheet stores inside
 * `range` (also cells with only a style), row by row in the order the sheet
 * keeps them. `visit` returns false to stop. Returns true when every stored
 * cell of the range was visited, false when `visit` stopped it or the sheet's
 * cells cannot be walked (the caller then treats the range as unknown).
 */
export function forEachStoredCell(
  internals: WorkbookInternals,
  sheet: SheetId,
  range: CellRange,
  visit: (row: number, col: number) => boolean,
): boolean {
  const doc = internals.getPartXml(internals.sheetPartName(sheet));
  if (doc === null) return false;
  let sheetData: XmlEl | null = null;
  for (const node of doc.root.children) {
    if (named(node, "sheetData")) {
      sheetData = node as XmlEl;
      break;
    }
  }
  if (sheetData === null) return false;
  let nextRow = 0;
  for (const rowNode of sheetData.children) {
    if (!named(rowNode, "row")) continue;
    const rowElement = rowNode as XmlEl;
    const rowAttr = attr(rowElement, "r");
    const row = rowAttr === null ? nextRow : Number(rowAttr) - 1;
    if (!Number.isInteger(row) || row < 0) return false;
    nextRow = row + 1;
    if (row < range.start.row || row > range.end.row) continue;
    let nextCol = 0;
    for (const cellNode of rowElement.children) {
      if (!named(cellNode, "c")) continue;
      const ref = attr(cellNode as XmlEl, "r");
      const col = ref === null ? nextCol : columnOf(ref);
      if (col < 0) return false;
      nextCol = col + 1;
      if (col < range.start.col || col > range.end.col) continue;
      if (!visit(row, col)) return false;
    }
  }
  return true;
}
