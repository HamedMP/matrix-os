/**
 * Copy, cut and paste.
 *
 * Copy puts tab-separated text and an HTML table on the clipboard and
 * remembers which cells they came from. A paste of that same text takes the
 * cells themselves: values, formulas with their references moved along, and
 * looks. Anything else pasted (from another program or another window) is
 * typed into the cells as text, formulas included when the HTML carries them.
 */

import { applyInputs } from "../session/edits";
import type { CellAddress, CellRange, RawCell, SheetId } from "../session/engine";
import { MAX_ACTION_CELLS, createCellWriter, report } from "./actions-data";
import { type ClipboardCell, type ParsedTable, readClipboard, serializeHtmlTable, serializeTsv } from "./clipboard";
import { cellLook } from "./cell-look";
import type { GridContext } from "./context";
import { adjustFormula } from "./fill";
import { activeRange, isSingleCell, rangeCols, rangeRows } from "./selection";

export interface ClipboardPayload {
  text: string;
  html: string;
}

/** The cells the last copy or cut took, to recognise its text when it is pasted back. */
export interface InternalClip {
  text: string;
  sheet: SheetId;
  range: CellRange;
  cut: boolean;
}

const clips = new WeakMap<GridContext, InternalClip>();
const pasting = new WeakSet<GridContext>();

/** True while a paste is writing cells, so that the change it causes does not end the copy it reads from. */
export function isPasting(ctx: GridContext): boolean {
  return pasting.has(ctx);
}
const TOO_MANY = "That is too many cells for one step. Select a smaller area.";

function normalize(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
}

/** The range a copy takes: the selected cells, cut to the used area for whole rows and columns. */
function copyRange(ctx: GridContext): CellRange {
  const range = activeRange(ctx.selection);
  if (range.kind === "cells") return { start: range.start, end: range.end };
  return ctx.usedRanges([range])[0] ?? { start: ctx.selection.active, end: ctx.selection.active };
}

/**
 * Builds the clipboard content for the selection and marks the cells as
 * copied (or cut: they are emptied when pasted). Null when nothing can be
 * copied.
 */
export function copySelection(ctx: GridContext, cut: boolean): ClipboardPayload | null {
  const sheet = ctx.sheet;
  const range = copyRange(ctx);
  if (rangeRows(range) * rangeCols(range) > MAX_ACTION_CELLS) {
    ctx.notice(TOO_MANY);
    return null;
  }
  const workbook = ctx.session.workbook;
  const texts: string[][] = [];
  const cells: ClipboardCell[][] = [];
  for (let row = range.start.row; row <= range.end.row; row++) {
    const textRow: string[] = [];
    const cellRow: ClipboardCell[] = [];
    for (let col = range.start.col; col <= range.end.col; col++) {
      const cell = ctx.session.cell(sheet, row, col);
      textRow.push(cell.display);
      const entry: ClipboardCell = { text: cell.display, formula: cell.formula };
      if (cell.styleId !== 0) {
        const style = workbook.getStyle(cell.styleId);
        const look = cellLook(style, cell.value);
        entry.bold = style.font.bold;
        entry.italic = style.font.italic;
        entry.underline = style.font.underline;
        entry.color = style.font.color;
        entry.background = style.fill.color;
        entry.align = style.alignment.horizontal === "general" ? null : look.align;
      }
      cellRow.push(entry);
    }
    texts.push(textRow);
    cells.push(cellRow);
  }
  const text = serializeTsv(texts);
  clips.set(ctx, { text: normalize(text), sheet, range, cut });
  ctx.store.set({ copy: { sheet, range, cut } });
  return { text, html: serializeHtmlTable(cells, { row: range.start.row, col: range.start.col }) };
}

export function clearCopyMark(ctx: GridContext): void {
  clips.delete(ctx);
  ctx.store.set({ copy: null });
}

/** Where copies of a block of `height` by `width` cells go: once at the active range, or tiled when the range is a multiple of the block. */
function targets(ctx: GridContext, height: number, width: number): CellAddress[] | null {
  const range = activeRange(ctx.selection);
  const origin = range.start;
  const single = [{ row: origin.row, col: origin.col }];
  if (range.kind !== "cells" || isSingleCell(ctx.selection, ctx.info().mergedRanges)) return single;
  const rows = rangeRows(range);
  const cols = rangeCols(range);
  if (rows % height !== 0 || cols % width !== 0) return single;
  if (rows * cols > MAX_ACTION_CELLS) return null;
  const out: CellAddress[] = [];
  for (let r = 0; r < rows / height; r++) {
    for (let c = 0; c < cols / width; c++) out.push({ row: origin.row + r * height, col: origin.col + c * width });
  }
  return out;
}

function selectPasted(ctx: GridContext, tiles: readonly CellAddress[], height: number, width: number): void {
  const first = tiles[0] as CellAddress;
  const last = tiles[tiles.length - 1] as CellAddress;
  const end = { row: last.row + height - 1, col: last.col + width - 1 };
  ctx.select({ ranges: [{ start: first, end, kind: "cells" }], active: first, anchor: first, focus: end }, first);
}

function pasteInternal(ctx: GridContext, clip: InternalClip): boolean {
  const session = ctx.session;
  const sheet = ctx.sheet;
  const height = rangeRows(clip.range);
  const width = rangeCols(clip.range);
  const tiles = targets(ctx, height, width);
  if (tiles === null || tiles.length * height * width > MAX_ACTION_CELLS) {
    ctx.notice(TOO_MANY);
    return false;
  }
  // Read the source first: the target may overlap it.
  const source: RawCell[][] = [];
  for (let r = 0; r < height; r++) {
    const row: RawCell[] = [];
    for (let c = 0; c < width; c++) row.push(session.raw(clip.sheet, clip.range.start.row + r, clip.range.start.col + c));
    source.push(row);
  }
  const ok = report(
    ctx,
    session.transact(clip.cut ? "Cut and paste" : "Paste", (tx) => {
      if (clip.cut) tx.workbook.clearRange(clip.sheet, clip.range, "all");
      const write = createCellWriter(tx.workbook, sheet, (row, col) => session.raw(sheet, row, col).styleId);
      for (const tile of tiles) {
        for (let r = 0; r < height; r++) {
          for (let c = 0; c < width; c++) {
            const cell = (source[r] as RawCell[])[c] as RawCell;
            const row = tile.row + r;
            const col = tile.col + c;
            // A moved formula keeps pointing at the same cells; a copied one moves its relative references.
            const formula =
              cell.formula === null || clip.cut
                ? cell.formula
                : adjustFormula(cell.formula, row - (clip.range.start.row + r), col - (clip.range.start.col + c));
            write(row, col, { value: cell.value, formula, styleId: cell.styleId });
          }
        }
      }
    }),
  );
  if (!ok) return false;
  if (clip.cut) clearCopyMark(ctx);
  selectPasted(ctx, tiles, height, width);
  return true;
}

function pasteExternal(ctx: GridContext, table: ParsedTable): boolean {
  const sheet = ctx.sheet;
  const height = table.rows.length;
  const width = table.rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (height === 0 || width === 0) return false;
  const tiles = targets(ctx, height, width);
  if (tiles === null || tiles.length * height * width > MAX_ACTION_CELLS) {
    ctx.notice(TOO_MANY);
    return false;
  }
  const ok = report(
    ctx,
    ctx.session.transact("Paste", (tx) => {
      for (const tile of tiles) {
        const rows = table.rows.map((row, r) =>
          row.map((text, c) => {
            const formula = table.formulas[r]?.[c] ?? null;
            if (formula === null || table.origin === null) return text;
            // Copied from a sheet: move relative references by the distance to the new place.
            return `=${adjustFormula(formula, tile.row - table.origin.row, tile.col - table.origin.col)}`;
          }),
        );
        applyInputs(tx.workbook, sheet, tile, rows);
      }
    }),
  );
  if (ok) selectPasted(ctx, tiles, height, width);
  return ok;
}

/** Pastes clipboard content at the selection. Returns true when cells were written. */
export function pasteClipboard(ctx: GridContext, data: { text?: string | null; html?: string | null }): boolean {
  const clip = clips.get(ctx) ?? null;
  const text = typeof data.text === "string" ? normalize(data.text) : "";
  pasting.add(ctx);
  try {
    if (clip !== null && text !== "" && text === clip.text && ctx.session.sheets().some((sheet) => sheet.id === clip.sheet)) {
      return pasteInternal(ctx, clip);
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
