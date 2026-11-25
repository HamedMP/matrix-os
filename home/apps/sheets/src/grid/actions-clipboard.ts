/**
 * Copy, cut and paste.
 *
 * Copy puts tab-separated text and an HTML table on the clipboard and
 * remembers which cells they came from. A paste of that same text takes the
 * cells themselves: values, formulas with their references moved along, and
 * looks. A cut and paste is a move: formulas that read the moved cells follow
 * them. Anything else pasted (from another program or another window) is
 * typed into the cells as text, formulas included when the HTML carries them,
 * and values copied from another Sheets window keep their full value and type.
 *
 * Rows a filter hides are skipped: copy takes the visible rows, and a paste
 * writes into visible rows only.
 */

import { applyInputs } from "../session/edits";
import type { CellAddress, CellRange, RawCell, SheetId } from "../session/engine";
import { MAX_ACTION_CELLS, createCellWriter, report } from "./actions-data";
import { type ClipboardCell, type ParsedTable, readClipboard, serializeHtmlTable, serializeTsv } from "./clipboard";
import { cellLook } from "./cell-look";
import type { GridContext } from "./context";
import { adjustFormula } from "./fill";
import { planMove } from "./move-cells";
import { activeRange, isSingleCell, rangeCols, rangeRows } from "./selection";
import { contiguous, hiddenRows, visibleRowsFrom, visibleRowsIn } from "./visible-rows";

export interface ClipboardPayload {
  text: string;
  html: string;
}

/** The cells the last copy or cut took, to recognise its text when it is pasted back. */
export interface InternalClip {
  text: string;
  sheet: SheetId;
  range: CellRange;
  /** The rows of the range that were copied: the ones the filter showed. */
  rows: readonly number[];
  cut: boolean;
}

const clips = new WeakMap<GridContext, InternalClip>();
const pasting = new WeakSet<GridContext>();

/** True while a paste is writing cells, so that the change it causes does not end the copy it reads from. */
export function isPasting(ctx: GridContext): boolean {
  return pasting.has(ctx);
}
const TOO_MANY = "That is too many cells for one step. Select a smaller area.";
const CUT_FILTERED = "Cut does not work across rows a filter hides. Copy the cells instead, or clear the filter first.";
const MOVE_TOO_LARGE = "This workbook is too large to move cells and update the formulas that use them. Copy the cells instead.";

function normalize(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
}

/** The range a copy takes: the selected cells, cut to the used area for whole rows and columns. */
function copyRange(ctx: GridContext): CellRange {
  const range = activeRange(ctx.selection);
  if (range.kind === "cells") return { start: range.start, end: range.end };
  return ctx.usedRanges([range])[0] ?? { start: ctx.selection.active, end: ctx.selection.active };
}

function clipboardCell(ctx: GridContext, sheet: SheetId, row: number, col: number): ClipboardCell {
  const cell = ctx.session.cell(sheet, row, col);
  const entry: ClipboardCell = { text: cell.display, formula: cell.formula };
  if (cell.formula === null && (typeof cell.value === "number" || typeof cell.value === "string" || typeof cell.value === "boolean")) {
    entry.value = cell.value;
  }
  if (cell.styleId !== 0) {
    const style = ctx.session.workbook.getStyle(cell.styleId);
    const look = cellLook(style, cell.value);
    entry.bold = style.font.bold;
    entry.italic = style.font.italic;
    entry.underline = style.font.underline;
    entry.color = style.font.color;
    entry.background = style.fill.color;
    entry.align = style.alignment.horizontal === "general" ? null : look.align;
  }
  return entry;
}

/**
 * Builds the clipboard content for the selection and marks the cells as
 * copied (or cut: they are moved when pasted). Rows a filter hides are left
 * out. Null when nothing can be copied.
 */
export function copySelection(ctx: GridContext, cut: boolean): ClipboardPayload | null {
  const sheet = ctx.sheet;
  const range = copyRange(ctx);
  if (rangeRows(range) * rangeCols(range) > MAX_ACTION_CELLS) {
    ctx.notice(TOO_MANY);
    return null;
  }
  const rows = visibleRowsIn(range.start.row, range.end.row, hiddenRows(ctx));
  if (rows.length === 0) return null;
  if (cut && !contiguous(rows)) {
    ctx.notice(CUT_FILTERED);
    return null;
  }
  const texts: string[][] = [];
  const cells: ClipboardCell[][] = [];
  for (const row of rows) {
    const cellRow: ClipboardCell[] = [];
    for (let col = range.start.col; col <= range.end.col; col++) cellRow.push(clipboardCell(ctx, sheet, row, col));
    texts.push(cellRow.map((cell) => cell.text));
    cells.push(cellRow);
  }
  const text = serializeTsv(texts);
  clips.set(ctx, { text: normalize(text), sheet, range, rows, cut });
  ctx.store.set({ copy: { sheet, range, cut } });
  return { text, html: serializeHtmlTable(cells, { row: range.start.row, col: range.start.col }) };
}

/**
 * Pastes the cells last copied or cut in this window, for when the system
 * clipboard cannot be read. False when nothing is marked as copied.
 */
export function pasteOwnCopy(ctx: GridContext): boolean {
  const clip = clips.get(ctx);
  if (clip === undefined || ctx.store.getState().copy === null || !ctx.session.sheets().some((sheet) => sheet.id === clip.sheet)) return false;
  pasting.add(ctx);
  try {
    if (clip.cut) pasteMove(ctx, clip);
    else pasteCopy(ctx, clip);
  } finally {
    pasting.delete(ctx);
  }
  return true;
}

export function clearCopyMark(ctx: GridContext): void {
  clips.delete(ctx);
  ctx.store.set({ copy: null });
}

/** One place a block is pasted: the sheet row each block row goes to, and the first column. */
interface Tile {
  rows: number[];
  col: number;
}

/**
 * Where copies of a block of `height` by `width` cells go: once at the active
 * range, or tiled when the range is a multiple of the block. Rows a filter
 * hides are skipped.
 */
function targets(ctx: GridContext, height: number, width: number): Tile[] | null {
  const range = activeRange(ctx.selection);
  const origin = range.start;
  const hidden = hiddenRows(ctx);
  const single = (): Tile[] => [{ rows: visibleRowsFrom(origin.row, height, hidden), col: origin.col }];
  if (range.kind !== "cells" || isSingleCell(ctx.selection, ctx.info().mergedRanges)) return single();
  const cols = rangeCols(range);
  if (rangeRows(range) * cols > MAX_ACTION_CELLS) return rangeRows(range) % height === 0 && cols % width === 0 ? null : single();
  const visible = visibleRowsIn(range.start.row, range.end.row, hidden);
  if (visible.length === 0 || visible.length % height !== 0 || cols % width !== 0) return single();
  const out: Tile[] = [];
  for (let r = 0; r < visible.length / height; r++) {
    for (let c = 0; c < cols / width; c++) out.push({ rows: visible.slice(r * height, (r + 1) * height), col: origin.col + c * width });
  }
  return out;
}

function selectPasted(ctx: GridContext, tiles: readonly Tile[], width: number): void {
  const first = tiles[0] as Tile;
  const last = tiles[tiles.length - 1] as Tile;
  const start = { row: first.rows[0] as number, col: first.col };
  const end = { row: last.rows[last.rows.length - 1] as number, col: last.col + width - 1 };
  ctx.select({ ranges: [{ start, end, kind: "cells" }], active: start, anchor: start, focus: end }, start);
}

function tooMany(tiles: readonly Tile[] | null, height: number, width: number): boolean {
  return tiles === null || tiles.length * height * width > MAX_ACTION_CELLS || tiles.some((tile) => tile.rows.length < height);
}

function pasteCopy(ctx: GridContext, clip: InternalClip): boolean {
  const session = ctx.session;
  const sheet = ctx.sheet;
  const height = clip.rows.length;
  const width = rangeCols(clip.range);
  const tiles = targets(ctx, height, width);
  if (tooMany(tiles, height, width)) {
    ctx.notice(TOO_MANY);
    return false;
  }
  const placed = tiles as Tile[];
  // Read the source first: the target may overlap it.
  const source: RawCell[][] = clip.rows.map((row) => {
    const cells: RawCell[] = [];
    for (let c = 0; c < width; c++) cells.push(session.raw(clip.sheet, row, clip.range.start.col + c));
    return cells;
  });
  const ok = report(
    ctx,
    session.transact("Paste", (tx) => {
      const write = createCellWriter(tx.workbook, sheet, (row, col) => session.raw(sheet, row, col).styleId);
      for (const tile of placed) {
        for (let r = 0; r < height; r++) {
          const row = tile.rows[r] as number;
          for (let c = 0; c < width; c++) {
            const cell = (source[r] as RawCell[])[c] as RawCell;
            const col = tile.col + c;
            // A copied formula moves its relative references by the distance it travelled.
            const formula = cell.formula === null ? null : adjustFormula(cell.formula, row - (clip.rows[r] as number), col - (clip.range.start.col + c));
            write(row, col, { value: cell.value, formula, styleId: cell.styleId });
          }
        }
      }
    }),
  );
  if (ok) selectPasted(ctx, placed, width);
  return ok;
}

/** Cut and paste: the cells move, and every formula that reads them follows. */
function pasteMove(ctx: GridContext, clip: InternalClip): boolean {
  const session = ctx.session;
  const sheet = ctx.sheet;
  const height = rangeRows(clip.range);
  const width = rangeCols(clip.range);
  const origin = activeRange(ctx.selection).start;
  const rows = visibleRowsFrom(origin.row, height, hiddenRows(ctx));
  if (rows.length < height) {
    ctx.notice(TOO_MANY);
    return false;
  }
  if (!contiguous(rows)) {
    ctx.notice(CUT_FILTERED);
    return false;
  }
  const tile: Tile = { rows, col: origin.col };
  const plan = planMove(session.workbook, clip.sheet, clip.range, { sheet, row: origin.row, col: origin.col });
  if (plan === null) {
    ctx.notice(MOVE_TOO_LARGE);
    return false;
  }
  const source: RawCell[][] = [];
  for (let r = 0; r < height; r++) {
    const cells: RawCell[] = [];
    for (let c = 0; c < width; c++) cells.push(session.raw(clip.sheet, clip.range.start.row + r, clip.range.start.col + c));
    source.push(cells);
  }
  const ok = report(
    ctx,
    session.transact("Cut and paste", (tx) => {
      tx.workbook.clearRange(clip.sheet, clip.range, "all");
      const write = createCellWriter(tx.workbook, sheet, (row, col) => session.raw(sheet, row, col).styleId);
      for (let r = 0; r < height; r++) {
        for (let c = 0; c < width; c++) {
          const cell = (source[r] as RawCell[])[c] as RawCell;
          const formula = cell.formula === null ? null : (plan.moved.get(`${r},${c}`) ?? cell.formula);
          write(origin.row + r, origin.col + c, { value: cell.value, formula, styleId: cell.styleId });
        }
      }
      // Formulas elsewhere that read the moved cells now point at their new place.
      for (const other of plan.others) tx.workbook.setFormula(other.sheet, { row: other.row, col: other.col }, other.formula);
    }),
  );
  if (!ok) return false;
  clearCopyMark(ctx);
  selectPasted(ctx, [tile], width);
  return true;
}

function pasteExternal(ctx: GridContext, table: ParsedTable): boolean {
  const sheet = ctx.sheet;
  const height = table.rows.length;
  const width = table.rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (height === 0 || width === 0) return false;
  const tiles = targets(ctx, height, width);
  if (tooMany(tiles, height, width)) {
    ctx.notice(TOO_MANY);
    return false;
  }
  const placed = tiles as Tile[];
  const ok = report(
    ctx,
    ctx.session.transact("Paste", (tx) => {
      for (const tile of placed) {
        table.rows.forEach((fields, r) => {
          const row = tile.rows[r] as number;
          fields.forEach((text, c) => {
            const col = tile.col + c;
            const formula = table.formulas[r]?.[c] ?? null;
            const value = table.values?.[r]?.[c];
            // Copied from another Sheets window: the stored value and its type, not the display text.
            if (formula === null && value !== undefined) tx.workbook.setCell(sheet, { row, col }, value);
            else {
              const input = formula === null || table.origin === null ? text : `=${adjustFormula(formula, row - (table.origin.row + r), col - table.origin.col)}`;
              applyInputs(tx.workbook, sheet, { row, col }, [[input]]);
            }
          });
        });
      }
    }),
  );
  if (ok) selectPasted(ctx, placed, width);
  return ok;
}

/** Pastes clipboard content at the selection. Returns true when cells were written. */
export function pasteClipboard(ctx: GridContext, data: { text?: string | null; html?: string | null }): boolean {
  const clip = clips.get(ctx) ?? null;
  const text = typeof data.text === "string" ? normalize(data.text) : "";
  pasting.add(ctx);
  try {
    if (clip !== null && text !== "" && text === clip.text && ctx.session.sheets().some((sheet) => sheet.id === clip.sheet)) {
      return clip.cut ? pasteMove(ctx, clip) : pasteCopy(ctx, clip);
    }
    const table = readClipboard(data);
    if (table === null) return false;
    const pasted = pasteExternal(ctx, table);
    if (pasted) clearCopyMark(ctx);
    return pasted;
  } finally {
    pasting.delete(ctx);
  }
}
