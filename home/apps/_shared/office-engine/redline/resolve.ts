/**
 * Accepting and rejecting changes.
 *
 * Resolving a change either keeps its items (an accepted insertion, a
 * rejected deletion), which puts them on the side that lacked them, or drops
 * them. Text is simple. Block boundaries need care, because a boundary says
 * which elements the *following* text sits in: when the first paragraph of a
 * document is restored, the restored text must get its own heading or list
 * item back and the text after it must keep its own. {@link keepRun} and
 * {@link dropRun} swap the chains of the boundaries involved so both do.
 */

import { OfficeError } from "../errors.js";
import { coalesce, pruneChanges } from "./merge.js";
import { KIND_BLOCK, type ChangeRecord, type DocData, type Item } from "./model.js";

type Side = "a" | "b";
type Action = "keep" | "drop" | null;

/** True when the item will be on `side` once this resolution is done. */
function staysOn(item: Item, side: Side, action: Action): boolean {
  if (action === "drop") return false;
  return item[side] !== null || action === "keep";
}

/** Whether inline content follows on `side` before the next block boundary that is on that side. */
function contentFollows(items: readonly Item[], from: number, side: Side, decide: (item: Item) => Action): boolean {
  for (let i = from; i < items.length; i += 1) {
    const item = items[i] as Item;
    if (!staysOn(item, side, decide(item))) continue;
    return item.k !== KIND_BLOCK;
  }
  return false;
}

/** The last boundary in `out` that is on `side`, and whether inline content on that side follows it. */
function lastBoundary(out: readonly Item[], side: Side): { boundary: Item; hasContent: boolean } {
  let hasContent = false;
  for (let i = out.length - 1; i > 0; i -= 1) {
    const item = out[i] as Item;
    if (item[side] === null) continue;
    if (item.k === KIND_BLOCK) return { boundary: item, hasContent };
    hasContent = true;
  }
  return { boundary: out[0] as Item, hasContent };
}

function lastBlockOf(run: readonly Item[]): Item | undefined {
  for (let i = run.length - 1; i >= 0; i -= 1) if ((run[i] as Item).k === KIND_BLOCK) return run[i];
  return undefined;
}

/** Makes a run of one-sided items permanent on both sides. */
function keepRun(out: Item[], run: Item[], contentAfter: boolean, have: Side, lack: Side): void {
  const lastBlock = lastBlockOf(run);
  if (lastBlock) {
    const target = lastBoundary(out, lack);
    if (!target.hasContent && contentAfter) {
      // The run opens the block the following text was in: that text keeps its chain,
      // and the run's first block takes the chain it has on the side it comes from.
      const source = lastBoundary(out, have).boundary;
      lastBlock[lack] = target.boundary[lack];
      target.boundary[lack] = source[have];
    }
  }
  for (const item of run) {
    if (item[lack] === null) item[lack] = item[have];
    item.c = null;
    out.push(item);
  }
}

/** Removes a run of one-sided items. */
function dropRun(out: Item[], run: Item[], contentAfter: boolean, have: Side): void {
  const lastBlock = lastBlockOf(run);
  if (!lastBlock) return;
  const target = lastBoundary(out, have);
  // The text after the run moves up into the block before it and brings its chain along.
  if (!target.hasContent && contentAfter) target.boundary[have] = lastBlock[have];
}

/**
 * Accepts or rejects the given changes. Ids are checked first: an unknown id
 * throws `stale_reference` and leaves the document as it was.
 */
export function resolveChanges(data: DocData, ids: readonly string[] | "all", accept: boolean): void {
  // Bounded by the number of pending changes.
  const byId = new Map<string, ChangeRecord>();
  for (const change of data.changes) byId.set(change.id, change);
  const chosen = new Set<string>();
  if (ids === "all") {
    for (const change of data.changes) chosen.add(change.id);
  } else {
    if (!Array.isArray(ids)) throw new OfficeError("invalid_argument", "change ids must be an array or the word all");
    for (const id of ids) {
      const change = typeof id === "string" ? byId.get(id) : undefined;
      if (!change) throw new OfficeError("stale_reference", "no pending change has this id");
      chosen.add(change.id);
      const isMove = change.kind === "moveFrom" || change.kind === "moveTo";
      if (isMove && change.pairedWith !== null && byId.has(change.pairedWith)) chosen.add(change.pairedWith);
    }
  }
  if (chosen.size === 0) return;
  const decide = (item: Item): Action => {
    if (item.c === null || !chosen.has(item.c)) return null;
    const inserted = item.a === null;
    return inserted === accept ? "keep" : "drop";
  };
  const items = data.items;
  const out: Item[] = [items[0] as Item];
  let i = 1;
  while (i < items.length) {
    const item = items[i] as Item;
    const action = decide(item);
    if (action === null) {
      out.push(item);
      i += 1;
      continue;
    }
    let end = i + 1;
    while (end < items.length && (items[end] as Item).c === item.c) end += 1;
    const run = items.slice(i, end);
    const have: Side = item.a === null ? "b" : "a";
    const lack: Side = have === "a" ? "b" : "a";
    if (action === "keep") keepRun(out, run, contentFollows(items, end, lack, decide), have, lack);
    else dropRun(out, run, contentFollows(items, end, have, decide), have);
    i = end;
  }
  data.items = coalesce(out);
  if (accept) data.accepted = true;
  pruneChanges(data);
  if (data.changes.length > 0) return;
  // Nothing is pending: both sides are one text again. Rejecting everything on a document
  // that never had a change accepted restores the original exactly, formatting included.
  const restore = !accept && !data.accepted;
  for (const each of data.items) {
    if (restore) each.b = each.a;
    else each.a = each.b;
  }
  data.items = coalesce(data.items);
  data.accepted = false;
}
