/**
 * Turns cell mutations into journal entries.
 *
 * - An edit inside a proposal creates the cell's entry, or updates the new
 *   content of the entry it already has (keeping the first old content); an
 *   entry whose new content equals its old content is dropped.
 * - An edit outside a proposal to a cell with an entry accepts that entry.
 * - A formula rewrite (a sheet renamed, rows moved) updates the new formula
 *   of the cell's entry, and is collected while a proposed structural edit runs.
 */

import type { CellValue } from "../../api/xlsx.js";
import type { CellMutation, RawCell } from "../workbook/internals.js";
import { type JournalContext, isActive } from "./context.js";
import { MAX_REWRITES } from "./types.js";

export function copyValue(value: CellValue): CellValue {
  return value !== null && typeof value === "object" ? { kind: "error", code: value.code } : value;
}

export function copyRaw(raw: RawCell): RawCell {
  return { value: copyValue(raw.value), formula: raw.formula, styleId: raw.styleId };
}

export function sameValue(a: CellValue, b: CellValue): boolean {
  if (a === b) return true;
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") return a.code === b.code;
  return false;
}

export function sameRaw(a: RawCell, b: RawCell): boolean {
  return a.formula === b.formula && a.styleId === b.styleId && sameValue(a.value, b.value);
}

/** True when a cell still holds the recorded content. A formula's value may change by calculation. */
export function holds(current: RawCell, recorded: RawCell): boolean {
  if (current.formula !== recorded.formula || current.styleId !== recorded.styleId) return false;
  return recorded.formula !== null || sameValue(current.value, recorded.value);
}

function onRewrite(ctx: JournalContext, mutation: CellMutation): void {
  if (ctx.capture !== null && mutation.before.formula !== null && mutation.after.formula !== null) {
    if (ctx.capture.length < MAX_REWRITES) {
      ctx.capture.push({ sheet: mutation.sheet, row: mutation.row, col: mutation.col, before: mutation.before.formula, after: mutation.after.formula });
    } else {
      ctx.captureOverflow = true;
    }
  }
  const entry = ctx.store.cellAt(mutation.sheet, mutation.row, mutation.col);
  if (entry !== undefined && entry.next.formula === mutation.before.formula) entry.next = { ...entry.next, formula: mutation.after.formula };
}

function onEdit(ctx: JournalContext, mutation: CellMutation): void {
  const store = ctx.store;
  const entry = store.cellAt(mutation.sheet, mutation.row, mutation.col);
  if (ctx.open === null) {
    if (entry !== undefined) {
      store.remove(entry);
      store.prune(null);
    }
    return;
  }
  if (entry !== undefined) {
    entry.next = copyRaw(mutation.after);
    if (sameRaw(entry.old, entry.next)) {
      store.remove(entry);
      store.prune(ctx.open);
    }
    return;
  }
  if (sameRaw(mutation.before, mutation.after)) return;
  try {
    store.requireRoom();
  } catch (error) {
    // The edit cannot be recorded, so it must not stay applied.
    ctx.suppress++;
    try {
      ctx.internals.writeRawCell(mutation.sheet, { row: mutation.row, col: mutation.col }, mutation.before);
    } finally {
      ctx.suppress--;
    }
    throw error;
  }
  store.add({
    kind: "cell",
    ...store.nextIds(),
    proposalId: ctx.open,
    sheet: mutation.sheet,
    row: mutation.row,
    col: mutation.col,
    old: copyRaw(mutation.before),
    next: copyRaw(mutation.after),
  });
}

export function onMutation(ctx: JournalContext, mutation: CellMutation): void {
  if (!isActive(ctx)) return;
  if (mutation.reason === "rewrite") {
    onRewrite(ctx, mutation);
    return;
  }
  if (ctx.suppress > 0) return;
  onEdit(ctx, mutation);
}
