/**
 * Find and replace over one sheet, row by row.
 *
 * "values" looks at what the grid shows; "formulas" looks at what was typed
 * (a formula with its `=`). Replacing in "values" changes typed text and
 * numbers only: a formula's result cannot be replaced, so such cells are
 * skipped and counted.
 */
import { editTextOf } from "../grid/actions-edit";
import { usesDate1904 } from "../session/date-system";
import type { SessionCellEdit } from "../session/edits";
import type { Cell, SheetId } from "../session/engine";
import type { SheetSession } from "../session/session";

export interface FindOptions {
  query: string;
  matchCase: boolean;
  /** The whole content must equal the query. */
  wholeCell: boolean;
  lookIn: "values" | "formulas";
}

export interface FindMatch {
  row: number;
  col: number;
}

export interface FindResult {
  matches: FindMatch[];
  /** True when there were more matches than the limit. */
  truncated: boolean;
}

export const MAX_MATCHES = 10_000;
/** Most cells looked at in one search. */
export const MAX_SCANNED_CELLS = 2_000_000;
export const MAX_QUERY_LENGTH = 1_000;

type Reader = Pick<SheetSession, "sheet" | "raw" | "cell" | "workbook">;

function normalise(text: string, matchCase: boolean): string {
  return matchCase ? text : text.toLocaleLowerCase();
}

function contains(haystack: string, options: FindOptions): boolean {
  const a = normalise(haystack, options.matchCase);
  const b = normalise(options.query, options.matchCase);
  return options.wholeCell ? a === b : a.includes(b);
}

function editText(reader: Reader, cell: Cell): string {
  const workbook = reader.workbook;
  return editTextOf(cell, workbook.getStyle(cell.styleId).numberFormat, usesDate1904(workbook));
}

/** The text a search compares for a cell. */
export function searchText(reader: Reader, sheet: SheetId, row: number, col: number, lookIn: FindOptions["lookIn"]): string {
  const raw = reader.raw(sheet, row, col);
  if (raw.formula === null && typeof raw.value === "string") return raw.value;
  const cell = reader.cell(sheet, row, col);
  return lookIn === "formulas" ? editText(reader, cell) : cell.display;
}

export function findMatches(reader: Reader, sheet: SheetId, options: FindOptions, limit = MAX_MATCHES): FindResult {
  const matches: FindMatch[] = [];
  if (options.query === "" || options.query.length > MAX_QUERY_LENGTH) return { matches, truncated: false };
  const used = reader.sheet(sheet).dimensions;
  if (used === null) return { matches, truncated: false };
  let scanned = 0;
  for (let row = used.start.row; row <= used.end.row; row++) {
    for (let col = used.start.col; col <= used.end.col; col++) {
      if (++scanned > MAX_SCANNED_CELLS) return { matches, truncated: true };
      const raw = reader.raw(sheet, row, col);
      if (raw.value === null && raw.formula === null) continue;
      if (!contains(searchText(reader, sheet, row, col, options.lookIn), options)) continue;
      if (matches.length >= limit) return { matches, truncated: true };
      matches.push({ row, col });
    }
  }
  return { matches, truncated: false };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replaces every occurrence of the query in `text`, or the whole text for a whole-cell match. */
export function replaceText(text: string, options: FindOptions, replacement: string): string {
  if (options.wholeCell) return replacement;
  // A function replacement keeps `$&` and friends in the replacement literal.
  return text.replace(new RegExp(escapeRegExp(options.query), options.matchCase ? "g" : "gi"), () => replacement);
}

/** The edit that replaces in one cell, or null when the cell cannot be changed this way. */
export function replaceEdit(reader: Reader, sheet: SheetId, match: FindMatch, options: FindOptions, replacement: string): SessionCellEdit | null {
  const { row, col } = match;
  const haystack = searchText(reader, sheet, row, col, options.lookIn);
  if (!contains(haystack, options)) return null;
  const raw = reader.raw(sheet, row, col);
  if (raw.formula === null && typeof raw.value === "string") {
    const next = replaceText(raw.value, options, replacement);
    return next === "" ? { sheet, row, col, input: "" } : { sheet, row, col, value: next };
  }
  const cell = reader.cell(sheet, row, col);
  if (cell.formula !== null && options.lookIn === "values") return null;
  if (cell.arrayRange !== null) return null;
  if (options.lookIn === "formulas" || options.wholeCell) return { sheet, row, col, input: replaceText(editText(reader, cell), options, replacement) };
  // A number matched on what is shown; replace in what was typed when the query is there too.
  const typed = editText(reader, cell);
  if (!contains(typed, options)) return null;
  return { sheet, row, col, input: replaceText(typed, options, replacement) };
}

export interface ReplaceAllPlan {
  edits: SessionCellEdit[];
  /** Matches that cannot be replaced (formula results, array formulas). */
  skipped: number;
  truncated: boolean;
}

export function planReplaceAll(reader: Reader, sheet: SheetId, options: FindOptions, replacement: string): ReplaceAllPlan {
  const found = findMatches(reader, sheet, options);
  const edits: SessionCellEdit[] = [];
  let skipped = 0;
  for (const match of found.matches) {
    const edit = replaceEdit(reader, sheet, match, options, replacement);
    if (edit === null) skipped++;
    else edits.push(edit);
  }
  return { edits, skipped, truncated: found.truncated };
}

/** The match after (or before) the active cell in reading order, wrapping around. */
export function nextMatch(matches: readonly FindMatch[], from: FindMatch, backwards = false): number {
  if (matches.length === 0) return -1;
  const after = (m: FindMatch) => m.row > from.row || (m.row === from.row && m.col > from.col);
  const before = (m: FindMatch) => m.row < from.row || (m.row === from.row && m.col < from.col);
  if (!backwards) {
    const index = matches.findIndex(after);
    return index < 0 ? 0 : index;
  }
  for (let i = matches.length - 1; i >= 0; i--) if (before(matches[i] as FindMatch)) return i;
  return matches.length - 1;
}
