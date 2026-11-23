/**
 * Accepting and rejecting pending changes.
 *
 * Rejection runs from the latest change to the earliest. Rejecting a
 * structural change or an added sheet also rejects every later change on
 * that sheet, since those were made on top of it. A stale change (the
 * workbook no longer holds its recorded new content) is left pending and
 * reported instead of being reverted, and so is a structural change that
 * still has later changes on its sheet after the run.
 */

import type { SheetCellRef } from "../../api/xlsx.js";
import { OfficeError, isOfficeError } from "../../errors.js";
import { bandIsEmpty, rangesMissing, sameRanges } from "./band.js";
import { type JournalContext, sheetOrNull } from "./context.js";
import { holds } from "./record.js";
import { applyAxis, applyRemove, applyRename } from "./structure.js";
import type { AxisEntry, JournalEntry, JournalResolveResult } from "./types.js";

function axisOf(entry: AxisEntry): "row" | "col" {
  return entry.kind === "insertRows" || entry.kind === "deleteRows" ? "row" : "col";
}

function isInsert(entry: AxisEntry): boolean {
  return entry.kind === "insertRows" || entry.kind === "insertColumns";
}

/** True when the workbook no longer holds what the change recorded as its result. */
export function isStale(ctx: JournalContext, entry: JournalEntry): boolean {
  const info = sheetOrNull(ctx, entry.sheet);
  if (info === null) return true;
  switch (entry.kind) {
    case "cell":
      return !holds(ctx.internals.readRawCell(entry.sheet, { row: entry.row, col: entry.col }), entry.next);
    case "renameSheet":
      return info.name !== entry.newName;
    case "addSheet":
      return false;
    default:
      return isInsert(entry) && !bandIsEmpty(ctx, info, axisOf(entry), entry.index, entry.count);
  }
}

/** The entries named by `ids`, in recording order. Throws before anything changes. */
export function resolveTargets(ctx: JournalContext, ids: readonly string[] | "all"): JournalEntry[] {
  if (ids === "all") return ctx.store.ordered();
  if (!Array.isArray(ids)) throw new OfficeError("invalid_argument", "ids must be a list of change ids or \"all\"");
  const found = new Map<string, JournalEntry>();
  for (const id of ids as readonly unknown[]) {
    if (typeof id !== "string") throw new OfficeError("invalid_argument", "a change id is text");
    const entry = ctx.store.entries.get(id);
    if (entry === undefined) throw new OfficeError("stale_reference", "no such change");
    found.set(id, entry);
  }
  return [...found.values()].sort((a, b) => a.seq - b.seq);
}

function recalc(ctx: JournalContext): void {
  ctx.workbook.recalc();
}

export function acceptEntries(ctx: JournalContext, ids: readonly string[] | "all"): JournalResolveResult {
  const targets = resolveTargets(ctx, ids);
  for (const entry of targets) ctx.store.remove(entry);
  ctx.store.prune(ctx.open);
  recalc(ctx);
  return { resolvedIds: targets.map((entry) => entry.id), restored: [], stale: [] };
}

/** Adds the later changes on the sheet of each structural change or added sheet. */
function withDependants(ctx: JournalContext, targets: JournalEntry[]): JournalEntry[] {
  const chosen = new Map(targets.map((entry) => [entry.id, entry]));
  for (const target of targets) {
    if (target.kind === "cell" || target.kind === "renameSheet") continue;
    for (const entry of ctx.store.entries.values()) {
      if (entry.sheet === target.sheet && entry.seq > target.seq) chosen.set(entry.id, entry);
    }
  }
  return [...chosen.values()].sort((a, b) => b.seq - a.seq);
}

function laterOnSheet(ctx: JournalContext, entry: JournalEntry): boolean {
  for (const other of ctx.store.entries.values()) if (other.sheet === entry.sheet && other.seq > entry.seq) return true;
  return false;
}

/** Runs a reversal that may be refused by the engine; false (and the entry back in the journal) when it is. */
function attempt(ctx: JournalContext, entry: JournalEntry, run: () => void): boolean {
  ctx.store.remove(entry);
  try {
    run();
    return true;
  } catch (error) {
    if (!isOfficeError(error, "invalid_operation", "invalid_argument", "not_found")) throw error;
    ctx.store.add(entry);
    return false;
  }
}

function revertAxis(ctx: JournalContext, entry: AxisEntry, restored: SheetCellRef[]): boolean {
  const { workbook, internals } = ctx;
  const axis = axisOf(entry);
  const insert = isInsert(entry);
  const toOriginal = (sheet: string, row: number, col: number): { row: number; col: number } => {
    if (sheet !== entry.sheet) return { row, col };
    const at = axis === "row" ? row : col;
    let moved = at;
    if (insert && at >= entry.index + entry.count) moved = at - entry.count;
    if (!insert && at >= entry.index) moved = at + entry.count;
    return axis === "row" ? { row: moved, col } : { row, col: moved };
  };
  // What still holds the state the edit produced can be put back exactly.
  const rewrites = (entry.rewrites ?? []).filter(
    (r) => internals.hasSheet(r.sheet) && internals.readRawCell(r.sheet, { row: r.row, col: r.col }).formula === r.after,
  );
  const currentNames = workbook.listDefinedNames();
  const names = entry.names.filter((n) =>
    currentNames.some((c) => c.name.toLowerCase() === n.name.toLowerCase() && c.scope === n.scope && c.refersTo === n.after),
  );
  const merges = entry.merges !== null && sameRanges(workbook.getSheet(entry.sheet).mergedRanges, entry.merges.after) ? entry.merges : null;
  // A state that came from a damaged file cannot be put back; the deletion then stays pending.
  const features = entry.features;
  if (features !== null && !internals.readableSheetFeatures(features)) return false;
  const ok = attempt(ctx, entry, () => applyAxis(ctx, entry.sheet, axis, entry.index, insert ? -entry.count : entry.count));
  if (!ok) return false;
  if (merges !== null) {
    const now = workbook.getSheet(entry.sheet).mergedRanges;
    for (const range of rangesMissing(now, merges.before)) workbook.unmergeCells(entry.sheet, range);
    for (const range of rangesMissing(merges.before, workbook.getSheet(entry.sheet).mergedRanges)) workbook.mergeCells(entry.sheet, range);
  }
  for (const cell of entry.snapshot?.cells ?? []) {
    internals.writeRawCell(entry.sheet, { row: cell.row, col: cell.col }, cell.raw);
    restored.push({ sheet: entry.sheet, row: cell.row, col: cell.col });
  }
  for (const size of entry.snapshot?.sizes ?? []) {
    if (axis === "row") workbook.setRowHeight(entry.sheet, size.index, size.size);
    else workbook.setColumnWidth(entry.sheet, size.index, size.size);
  }
  for (const r of rewrites) {
    const at = toOriginal(r.sheet, r.row, r.col);
    const current = internals.readRawCell(r.sheet, at);
    if (current.formula !== r.before) internals.writeRawCell(r.sheet, at, { ...current, formula: r.before });
  }
  for (const n of names) {
    if (n.scope === null || internals.hasSheet(n.scope)) workbook.setDefinedName({ name: n.name, scope: n.scope, refersTo: n.before });
  }
  // Last, so that array formulas find their cells and rows their restored content.
  if (features !== null) internals.restoreSheetFeatures(entry.sheet, features);
  return true;
}

function revert(ctx: JournalContext, entry: JournalEntry, restored: SheetCellRef[]): boolean {
  switch (entry.kind) {
    case "cell":
      ctx.store.remove(entry);
      ctx.internals.writeRawCell(entry.sheet, { row: entry.row, col: entry.col }, entry.old);
      restored.push({ sheet: entry.sheet, row: entry.row, col: entry.col });
      return true;
    case "renameSheet":
      return attempt(ctx, entry, () => applyRename(ctx, entry.sheet, entry.oldName));
    case "addSheet":
      if (ctx.workbook.getSheet(entry.sheet).dimensions !== null) return false;
      return attempt(ctx, entry, () => applyRemove(ctx, entry.sheet));
    default:
      return revertAxis(ctx, entry, restored);
  }
}

export function rejectEntries(ctx: JournalContext, ids: readonly string[] | "all"): JournalResolveResult {
  const order = withDependants(ctx, resolveTargets(ctx, ids));
  const resolvedIds: string[] = [];
  const stale: string[] = [];
  const restored: SheetCellRef[] = [];
  ctx.suppress++;
  try {
    for (const entry of order) {
      const blocked = entry.kind !== "cell" && entry.kind !== "renameSheet" && laterOnSheet(ctx, entry);
      if (blocked || isStale(ctx, entry) || !revert(ctx, entry, restored)) stale.push(entry.id);
      else resolvedIds.push(entry.id);
    }
  } finally {
    ctx.suppress--;
  }
  ctx.store.prune(ctx.open);
  recalc(ctx);
  return { resolvedIds, restored, stale };
}
