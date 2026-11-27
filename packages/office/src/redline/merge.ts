/**
 * Folds a new version of the final text into a tracked document.
 *
 * The final side of the document is compared with the new version. What is
 * equal stays (and takes the formatting of the new version), what is gone
 * becomes a pending deletion, what is new becomes a pending insertion.
 * Pending deletions already in the document stay where they are.
 *
 * `createRedline` is this operation on a document without changes; a user
 * edit is the same on a document that may already have some. For user edits
 * two rules keep typing from flooding the change list:
 * - deleting text that is itself a pending insertion just removes it;
 * - an insertion or deletion next to a pending one of the same kind by the
 *   same author joins it and keeps its id.
 */

import type { RedlineChangeKind } from "../api/redline.js";
import { OfficeError } from "../errors.js";
import { diffWords } from "./diff.js";
import { KIND_BLOCK, KIND_TEXT, type ChangeRecord, type DocData, type Item, type SideItem } from "./model.js";

export interface EditOptions {
  author: string;
  date: string;
  detectMoves?: boolean;
}

/** Longest author name and date kept on a change. */
const MAX_AUTHOR_LENGTH = 256;
const MAX_DATE_LENGTH = 64;

export function checkEditOptions(options: EditOptions): void {
  if (options === null || typeof options !== "object" || typeof options.author !== "string" || typeof options.date !== "string") {
    throw new OfficeError("invalid_argument", "a redline needs an author and a date");
  }
  if (options.author.length > MAX_AUTHOR_LENGTH || options.date.length === 0 || options.date.length > MAX_DATE_LENGTH) {
    throw new OfficeError("invalid_argument", "author or date has an invalid length");
  }
}

function sideText(items: readonly { t: string }[]): string {
  let out = "";
  for (let i = 1; i < items.length; i += 1) out += (items[i] as { t: string }).t;
  return out;
}

function tagOf(entry: string): string {
  return entry.slice(0, entry.indexOf(":"));
}

/** Drops changes that no item carries any more and repairs the pairs that lost a half. */
export function pruneChanges(data: DocData): void {
  // Bounded by the number of items.
  const live = new Set<string>();
  for (const item of data.items) if (item.c !== null) live.add(item.c);
  data.changes = data.changes.filter((change) => live.has(change.id));
  for (const change of data.changes) {
    if (change.pairedWith === null || live.has(change.pairedWith)) continue;
    change.pairedWith = null;
    if (change.kind === "moveFrom") change.kind = "delete";
    else if (change.kind === "moveTo") change.kind = "insert";
  }
}

/** Joins neighbouring text items that look the same on both sides and belong to the same change. */
export function coalesce(items: Item[]): Item[] {
  const out: Item[] = [];
  for (const item of items) {
    const last = out[out.length - 1];
    if (last && out.length > 1 && last.k === KIND_TEXT && item.k === KIND_TEXT && last.a === item.a && last.b === item.b && last.c === item.c) {
      last.t += item.t;
    } else {
      out.push(item);
    }
  }
  return out;
}

export function applyEdit(data: DocData, next: readonly SideItem[], options: EditOptions): void {
  const old = data.items;
  const oldText = sideText(old.filter((item, index) => index === 0 || item.b !== null));
  const ops = diffWords(oldText, sideText(next), { detectMoves: options.detectMoves ?? true });
  // Bounded by the number of changes, itself bounded by the number of items.
  const changes = new Map<string, ChangeRecord>();
  for (const change of data.changes) changes.set(change.id, change);
  const mine = (id: string | null, kind: RedlineChangeKind): boolean => {
    const change = id === null ? undefined : changes.get(id);
    return change !== undefined && change.kind === kind && change.author === options.author;
  };
  const create = (kind: RedlineChangeKind): string => {
    const id = `c${data.nextChange}`;
    data.nextChange += 1;
    const change: ChangeRecord = { id, kind, author: options.author, date: options.date, pairedWith: null };
    changes.set(id, change);
    data.changes.push(change);
    return id;
  };

  const out: Item[] = [{ ...(old[0] as Item), b: (next[0] as SideItem).p }];
  let oi = 1;
  let oOff = 0;
  let ni = 1;
  let nOff = 0;
  let oldChain = (old[0] as Item).b as string;
  let newChain = (next[0] as SideItem).p;
  // Block element ids of the old document that are the same element in the new version.
  const rename = new Map<string, string>();
  const taken = new Set<string>();
  let pairedOld: string | null = null;
  let pairedNew: string | null = null;
  const pairChains = (): void => {
    if (oldChain === pairedOld && newChain === pairedNew) return;
    pairedOld = oldChain;
    pairedNew = newChain;
    if (oldChain === "" || newChain === "") return;
    const from = oldChain.split("/");
    const to = newChain.split("/");
    for (let i = 0; i < from.length && i < to.length; i += 1) {
      const source = from[i] as string;
      const target = to[i] as string;
      if (tagOf(source) !== tagOf(target)) return;
      const known = rename.get(source);
      if (known !== undefined) {
        if (known !== target) return;
      } else {
        if (taken.has(target)) return;
        rename.set(source, target);
        taken.add(target);
      }
    }
  };

  const passDeleted = (): void => {
    while (oOff === 0 && oi < old.length && (old[oi] as Item).b === null) {
      out.push(old[oi] as Item);
      oi += 1;
    }
  };
  /** Consumes `length` code units of the final side of the old document, piece by piece. */
  const takeOld = (length: number, each: (item: Item, piece: string) => void): void => {
    let left = length;
    while (left > 0) {
      passDeleted();
      const item = old[oi];
      if (!item) throw new OfficeError("invalid_operation", "redline items do not cover the compared text");
      const size = Math.min(item.t.length - oOff, left);
      if (item.k === KIND_BLOCK) oldChain = item.b as string;
      each(item, item.t.slice(oOff, oOff + size));
      oOff += size;
      left -= size;
      if (oOff === item.t.length) {
        oi += 1;
        oOff = 0;
      }
    }
  };
  const takeNew = (length: number, each: (item: SideItem, piece: string) => void): void => {
    let left = length;
    while (left > 0) {
      const item = next[ni];
      if (!item) throw new OfficeError("invalid_operation", "new items do not cover the compared text");
      const size = Math.min(item.t.length - nOff, left);
      if (item.k === KIND_BLOCK) newChain = item.p;
      each(item, item.t.slice(nOff, nOff + size));
      nOff += size;
      left -= size;
      if (nOff === item.t.length) {
        ni += 1;
        nOff = 0;
      }
    }
  };

  const moves = new Map<string, { from: string | null; to: string | null }>();
  /** A pending insertion of this author that the previous op removed: its replacement keeps the id. */
  let retracted: string | null = null;
  /** The deletion the previous op created, to pair with a following insertion. */
  let createdDelete: string | null = null;

  for (const op of ops) {
    const length = op.text.length;
    if (op.type === "equal") {
      let left = length;
      while (left > 0) {
        passDeleted();
        const oldItem = old[oi] as Item;
        const newItem = next[ni] as SideItem;
        const size = Math.min(oldItem.t.length - oOff, newItem.t.length - nOff, left);
        takeOld(size, (item, piece) => {
          takeNew(size, (fresh) => {
            out.push({ k: fresh.k, t: piece, a: item.a, b: fresh.p, c: item.c });
            if (fresh.k !== KIND_BLOCK) pairChains();
          });
        });
        left -= size;
      }
      retracted = null;
      createdDelete = null;
      continue;
    }
    if (op.type === "delete" || op.type === "moveFrom") {
      const made: Item[] = [];
      let dropped: string | null = null;
      // Where the first new deletion landed in `out`; what follows it there are the
      // new deletions and older pending deletions that sit between them.
      let first = -1;
      takeOld(length, (item, piece) => {
        if (item.a === null) {
          if (mine(item.c, "insert")) dropped = item.c;
          return;
        }
        const deleted: Item = { k: item.k, t: piece, a: item.a, b: null, c: null };
        if (first === -1) first = out.length;
        made.push(deleted);
        out.push(deleted);
      });
      retracted = dropped;
      createdDelete = null;
      if (made.length === 0) continue;
      let id: string | null = null;
      if (op.type === "moveFrom") {
        id = create("moveFrom");
        const move = moves.get(op.moveId as string) ?? { from: null, to: null };
        move.from = id;
        moves.set(op.moveId as string, move);
      } else {
        // A deletion that touches a pending deletion by the same author continues it.
        passDeleted();
        for (let at = first - 1; at < out.length; at += 1) {
          const neighbour = out[at];
          if (neighbour && neighbour.b === null && neighbour.c !== null && mine(neighbour.c, "delete")) {
            id = neighbour.c;
            break;
          }
        }
        if (id === null) {
          id = create("delete");
          createdDelete = id;
        }
      }
      for (const item of made) item.c = id;
      continue;
    }
    // insert or moveTo
    passDeleted();
    const before = out[out.length - 1] as Item;
    const after = old[oi];
    let id: string;
    if (op.type === "moveTo") {
      id = create("moveTo");
      const move = moves.get(op.moveId as string) ?? { from: null, to: null };
      move.to = id;
      moves.set(op.moveId as string, move);
    } else if (retracted !== null) {
      id = retracted;
    } else if (out.length > 1 && before.a === null && mine(before.c, "insert")) {
      id = before.c as string;
    } else if (after && after.a === null && mine(after.c, "insert")) {
      id = after.c as string;
    } else {
      id = create("insert");
      // A replacement: the deletion just made, or an unpaired pending one by the same author right before.
      let deletion = createdDelete;
      if (deletion === null && before.b === null && mine(before.c, "delete") && changes.get(before.c as string)?.pairedWith === null) {
        deletion = before.c;
      }
      if (deletion !== null) {
        (changes.get(id) as ChangeRecord).pairedWith = deletion;
        (changes.get(deletion) as ChangeRecord).pairedWith = id;
      }
    }
    takeNew(length, (fresh, piece) => {
      out.push({ k: fresh.k, t: piece, a: null, b: fresh.p, c: id });
    });
    retracted = null;
    createdDelete = null;
  }
  passDeleted();
  if (oi !== old.length || ni !== next.length) throw new OfficeError("invalid_operation", "redline merge did not consume both versions");

  for (const move of moves.values()) {
    const from = move.from === null ? undefined : changes.get(move.from);
    const to = move.to === null ? undefined : changes.get(move.to);
    if (from && to) {
      from.pairedWith = to.id;
      to.pairedWith = from.id;
    } else if (from) {
      from.kind = "delete";
    } else if (to) {
      to.kind = "insert";
    }
  }
  if (rename.size > 0) {
    for (const item of out) {
      if (item.k !== KIND_BLOCK || item.a === null || item.a === "") continue;
      item.a = item.a
        .split("/")
        .map((entry) => rename.get(entry) ?? entry)
        .join("/");
    }
  }
  data.items = coalesce(out);
  pruneChanges(data);
}
