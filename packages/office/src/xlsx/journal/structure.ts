/**
 * Sheet and structure edits under the journal.
 *
 * The workbook tells listeners about cell edits only, so the journal wraps
 * the handle's `insertRows`, `deleteRows`, `insertColumns`, `deleteColumns`,
 * `addSheet`, `renameSheet` and `removeSheet`. Outside a proposal a wrapper
 * applies the edit and keeps the old formulas of pending changes in step
 * with it; inside a proposal it also records the edit with what is needed to
 * undo it. Removing a sheet cannot be proposed and throws `invalid_operation`.
 */

import type { DefinedName, SheetId, SheetInfo, Workbook } from "../../api/xlsx.js";
import { OfficeError } from "../../errors.js";
import { MAX_COLS, MAX_ROWS } from "../workbook/a1.js";
import { type StructuralOp, rewriteForRemoval, rewriteForRename, rewriteForStructure } from "../workbook/refs-rewrite.js";
import { type Axis, captureBand, sameRanges } from "./band.js";
import { type JournalContext, type OriginalMethods, isActive } from "./context.js";
import { readableEntry } from "./parse.js";
import { entryJson } from "./persist.js";
import { rejectEntries } from "./revert.js";
import {
  type AxisEntry,
  type AxisKind,
  MAX_KEPT_MERGES,
  MAX_KEPT_NAMES,
  MAX_REWRITES,
  type NameRewrite,
  type RenameSheetEntry,
} from "./types.js";

/**
 * Rewrites the formulas the journal keeps to put back: the old formula of
 * every pending cell change, and the cells and feature formulas a pending
 * deletion took.
 */
function rewriteOldFormulas(ctx: JournalContext, rewrite: (text: string, sheet: SheetId) => string): void {
  for (const entry of ctx.store.entries.values()) {
    if (entry.kind === "cell") {
      if (entry.old.formula === null) continue;
      const text = rewrite(entry.old.formula, entry.sheet);
      if (text !== entry.old.formula) entry.old = { ...entry.old, formula: text };
    } else if (entry.kind === "deleteRows" || entry.kind === "deleteColumns") {
      for (const cell of entry.snapshot?.cells ?? []) {
        if (cell.raw.formula === null) continue;
        const text = rewrite(cell.raw.formula, entry.sheet);
        if (text !== cell.raw.formula) cell.raw = { ...cell.raw, formula: text };
      }
      if (entry.features !== null) entry.features = ctx.internals.rewriteSheetFeatures(entry.features, (text) => rewrite(text, entry.sheet));
      entry.linked = entry.linked.map((linked) => ctx.internals.rewriteLinkedFeatures(linked, (text) => rewrite(text, linked.sheet)));
    }
  }
}

/** Inserts (`count` above 0) or deletes rows or columns through the workbook's own method. */
export function applyAxis(ctx: JournalContext, sheet: SheetId, axis: Axis, index: number, count: number): void {
  const key = ctx.workbook.getSheet(sheet).name.toLowerCase();
  const o = ctx.original;
  if (axis === "row") (count > 0 ? o.insertRows : o.deleteRows)(sheet, index, Math.abs(count));
  else (count > 0 ? o.insertColumns : o.deleteColumns)(sheet, index, Math.abs(count));
  const op: StructuralOp = { axis, index, count };
  rewriteOldFormulas(ctx, (text, owner) => rewriteForStructure(text, owner === sheet, key, op));
}

export function applyRename(ctx: JournalContext, sheet: SheetId, name: string): void {
  const oldName = ctx.workbook.getSheet(sheet).name;
  ctx.original.renameSheet(sheet, name);
  if (oldName !== name) rewriteOldFormulas(ctx, (text) => rewriteForRename(text, oldName.toLowerCase(), name));
}

export function applyRemove(ctx: JournalContext, sheet: SheetId): void {
  const key = ctx.workbook.getSheet(sheet).name.toLowerCase();
  ctx.original.removeSheet(sheet);
  rewriteOldFormulas(ctx, (text) => rewriteForRemoval(text, key));
}

function nameKey(name: DefinedName): string {
  return `${name.name.toLowerCase()}|${name.scope ?? ""}`;
}

function nameRewrites(before: DefinedName[], after: DefinedName[]): NameRewrite[] {
  const old = new Map(before.map((name) => [nameKey(name), name]));
  const changed: NameRewrite[] = [];
  for (const name of after) {
    const previous = old.get(nameKey(name));
    if (previous !== undefined && previous.refersTo !== name.refersTo) {
      changed.push({ name: name.name, scope: name.scope, before: previous.refersTo, after: name.refersTo });
    }
  }
  return changed;
}

/** True when the arguments name rows or columns the engine accepts; otherwise the engine throws for them. */
function validAxisArgs(axis: Axis, index: number, count: number): boolean {
  const limit = axis === "row" ? MAX_ROWS : MAX_COLS;
  return Number.isInteger(index) && Number.isInteger(count) && index >= 0 && count >= 1 && index + count <= limit;
}

const AXIS_KIND: Record<Axis, readonly [AxisKind, AxisKind]> = {
  row: ["insertRows", "deleteRows"],
  col: ["insertColumns", "deleteColumns"],
};

function proposeAxis(ctx: JournalContext, sheet: SheetId, axis: Axis, index: number, count: number, sign: 1 | -1): void {
  const workbook = ctx.workbook;
  const info: SheetInfo = workbook.getSheet(sheet);
  if (!validAxisArgs(axis, index, count) || ctx.store.countFor(sheet) > 0) {
    // The engine throws the right error for these.
    applyAxis(ctx, sheet, axis, index, sign * count);
    return;
  }
  ctx.store.requireRoom();
  const snapshot = sign < 0 ? captureBand(ctx, info, axis, index, count) : null;
  const features = sign < 0 ? ctx.internals.captureSheetFeatures(sheet, axis, index, count) : null;
  // A deletion turns references from other sheets' links, formats and validations into #REF! as well.
  const linked = sign < 0 ? ctx.internals.captureLinkedFeatures(sheet, axis, index, count) : [];
  const namesBefore = workbook.listDefinedNames();
  const kind = AXIS_KIND[axis][sign > 0 ? 0 : 1];
  // What is kept from before the edit is checked before anything changes; the edit keeps the number of
  // merged ranges and names, or lowers it.
  const before: AxisEntry = {
    kind,
    id: "c1",
    seq: 1,
    proposalId: ctx.open as string,
    sheet,
    index,
    count,
    snapshot,
    rewrites: null,
    names: [],
    merges: null,
    features,
    linked,
  };
  if (info.mergedRanges.length > MAX_KEPT_MERGES || namesBefore.length > MAX_KEPT_NAMES || !readableEntry(entryJson(before))) {
    throw unkeepable();
  }
  // A deletion turns references to its cells into #REF!; only the kept formulas can give them back on reject.
  if (sign < 0 && ctx.internals.structureRewritesExceed(sheet, axis, index, -count, MAX_REWRITES)) {
    throw new OfficeError("limit_exceeded", "the deletion rewrites too many formulas to keep as a proposal", {
      details: { maxRewrites: MAX_REWRITES },
    });
  }
  ctx.capture = [];
  ctx.captureOverflow = false;
  let rewrites;
  try {
    applyAxis(ctx, sheet, axis, index, sign * count);
  } finally {
    rewrites = ctx.captureOverflow ? null : ctx.capture;
    ctx.capture = null;
    ctx.captureOverflow = false;
  }
  const mergesAfter = workbook.getSheet(sheet).mergedRanges;
  const entry: AxisEntry = {
    kind,
    ...ctx.store.nextIds(),
    proposalId: ctx.open as string,
    sheet,
    index,
    count,
    snapshot,
    rewrites,
    names: nameRewrites(namesBefore, workbook.listDefinedNames()),
    merges: sameRanges(info.mergedRanges, mergesAfter) ? null : { before: info.mergedRanges, after: mergesAfter },
    features,
    linked,
  };
  ctx.store.add(entry);
  // Rewritten formulas and names can come out longer than a journal holds: the edit is then taken back.
  if (!readableEntry(entryJson(entry))) {
    rejectEntries(ctx, [entry.id]);
    throw unkeepable();
  }
}

function unkeepable(): OfficeError {
  return new OfficeError("limit_exceeded", "the change is too large to keep as a proposal");
}

function proposeAddSheet(ctx: JournalContext, name: string, index: number | undefined): SheetInfo {
  ctx.store.requireRoom();
  const added = ctx.original.addSheet(name, index);
  ctx.store.add({ kind: "addSheet", ...ctx.store.nextIds(), proposalId: ctx.open as string, sheet: added.id, name: added.name });
  return ctx.workbook.getSheet(added.id);
}

function pendingRename(ctx: JournalContext, sheet: SheetId): RenameSheetEntry | undefined {
  for (const entry of ctx.store.entries.values()) if (entry.kind === "renameSheet" && entry.sheet === sheet) return entry;
  return undefined;
}

function rename(ctx: JournalContext, sheet: SheetId, name: string): void {
  const oldName = ctx.workbook.getSheet(sheet).name;
  const existing = pendingRename(ctx, sheet);
  if (ctx.open === null) {
    applyRename(ctx, sheet, name);
    // A rename outside a proposal accepts the pending one.
    if (existing !== undefined && oldName !== name) {
      ctx.store.remove(existing);
      ctx.store.prune(null);
    }
    return;
  }
  if (existing === undefined) ctx.store.requireRoom();
  applyRename(ctx, sheet, name);
  if (oldName === name) return;
  if (existing !== undefined) {
    existing.newName = name;
    if (existing.oldName === name) {
      ctx.store.remove(existing);
      ctx.store.prune(ctx.open);
    }
    return;
  }
  ctx.store.add({ kind: "renameSheet", ...ctx.store.nextIds(), proposalId: ctx.open, sheet, oldName, newName: name });
}

/** The handle's own methods, bound to it. */
export function originalMethods(workbook: Workbook): OriginalMethods {
  const proto = Object.getPrototypeOf(workbook) as Workbook;
  return {
    insertRows: proto.insertRows.bind(workbook),
    deleteRows: proto.deleteRows.bind(workbook),
    insertColumns: proto.insertColumns.bind(workbook),
    deleteColumns: proto.deleteColumns.bind(workbook),
    addSheet: proto.addSheet.bind(workbook),
    renameSheet: proto.renameSheet.bind(workbook),
    removeSheet: proto.removeSheet.bind(workbook),
  };
}

function define<K extends keyof OriginalMethods>(workbook: Workbook, name: K, value: OriginalMethods[K]): void {
  Object.defineProperty(workbook, name, { value, configurable: true, writable: true, enumerable: false });
}

/** Replaces the sheet and structure methods of the handle with journaled ones. */
export function installWrappers(ctx: JournalContext): void {
  const { workbook, original } = ctx;
  const axis =
    (kind: Axis, sign: 1 | -1, plain: (sheet: SheetId, index: number, count: number) => void) =>
    (sheet: SheetId, index: number, count: number): void => {
      // A count that is not a positive whole number goes to the engine, which throws for it.
      if (!isActive(ctx) || !Number.isInteger(count) || count < 1) return plain(sheet, index, count);
      if (ctx.open === null) return applyAxis(ctx, sheet, kind, index, sign * count);
      proposeAxis(ctx, sheet, kind, index, count, sign);
    };
  define(workbook, "insertRows", axis("row", 1, original.insertRows));
  define(workbook, "deleteRows", axis("row", -1, original.deleteRows));
  define(workbook, "insertColumns", axis("col", 1, original.insertColumns));
  define(workbook, "deleteColumns", axis("col", -1, original.deleteColumns));
  define(workbook, "addSheet", (name: string, index?: number): SheetInfo => {
    if (!isActive(ctx) || ctx.open === null) return original.addSheet(name, index);
    return proposeAddSheet(ctx, name, index);
  });
  define(workbook, "renameSheet", (sheet: SheetId, name: string): void => {
    if (!isActive(ctx)) return original.renameSheet(sheet, name);
    rename(ctx, sheet, name);
  });
  define(workbook, "removeSheet", (sheet: SheetId): void => {
    if (!isActive(ctx)) return original.removeSheet(sheet);
    if (ctx.open !== null) {
      workbook.getSheet(sheet);
      throw new OfficeError("invalid_operation", "removing a sheet cannot be proposed");
    }
    applyRemove(ctx, sheet);
  });
}

