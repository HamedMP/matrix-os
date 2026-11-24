/**
 * Saving and loading a tracked document.
 *
 * A saved state comes back from storage, so it is untrusted: loading checks
 * every field, and in particular everything that later becomes markup
 * (element names, link targets) against the same allow-list the HTML reader
 * uses. A state that fails any check is refused with `invalid_argument`.
 */

import type { RedlineChangeKind, RedlineState } from "../api/redline.js";
import { OfficeError } from "../errors.js";
import {
  BLOCK_CHAR,
  BREAK_CHAR,
  KIND_BLOCK,
  KIND_BREAK,
  KIND_TEXT,
  MAX_REDLINE_LENGTH,
  validPresentation,
  type ChangeRecord,
  type DocData,
  type Item,
  type ItemKind,
} from "./model.js";

/** Most items a saved state may hold. */
const MAX_ITEMS = 1_000_000;
const CHANGE_ID = /^c[1-9][0-9]{0,8}$/;
const KINDS: ReadonlySet<string> = new Set<RedlineChangeKind>(["insert", "delete", "moveFrom", "moveTo"]);

export function saveState(data: DocData): RedlineState {
  return {
    version: 1,
    format: data.format,
    items: data.items.map((item) => [item.k, item.t, item.a, item.b, item.c]),
    changes: data.changes.map((change) => ({ ...change })),
    nextChange: data.nextChange,
    nextBlock: data.nextBlock,
    accepted: data.accepted,
  };
}

function refuse(reason: string): never {
  throw new OfficeError("invalid_argument", `redline state is not valid: ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function readChanges(raw: unknown): Map<string, ChangeRecord> {
  if (!Array.isArray(raw) || raw.length > MAX_ITEMS) refuse("changes");
  // Bounded by MAX_ITEMS.
  const changes = new Map<string, ChangeRecord>();
  for (const entry of raw as unknown[]) {
    if (!isRecord(entry)) refuse("change");
    const { id, kind, author, date, pairedWith } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !CHANGE_ID.test(id) || changes.has(id)) refuse("change id");
    if (typeof kind !== "string" || !KINDS.has(kind)) refuse("change kind");
    if (typeof author !== "string" || author.length > 256) refuse("change author");
    if (typeof date !== "string" || date.length === 0 || date.length > 64) refuse("change date");
    if (pairedWith !== null && typeof pairedWith !== "string") refuse("change pair");
    changes.set(id as string, {
      id: id as string,
      kind: kind as RedlineChangeKind,
      author: author as string,
      date: date as string,
      pairedWith: pairedWith as string | null,
    });
  }
  for (const change of changes.values()) {
    if (change.pairedWith === null) continue;
    const pair = changes.get(change.pairedWith);
    if (!pair || pair.pairedWith !== change.id || pair.id === change.id) refuse("change pair");
  }
  return changes;
}

/** Checks a saved state and turns it back into document data. */
export function loadState(state: unknown): DocData {
  if (!isRecord(state) || state.version !== 1) refuse("version");
  const raw = state as Record<string, unknown>;
  const format = raw.format;
  if (format !== "text" && format !== "html") refuse("format");
  const changes = readChanges(raw.changes);
  if (!Array.isArray(raw.items) || raw.items.length === 0 || raw.items.length > MAX_ITEMS) refuse("items");
  const items: Item[] = [];
  const used = new Set<string>();
  let length = 0;
  let maxBlock = 0;
  (raw.items as unknown[]).forEach((entry, index) => {
    if (!Array.isArray(entry) || entry.length !== 5) refuse("item");
    const [k, t, a, b, c] = entry as unknown[];
    if (k !== KIND_TEXT && k !== KIND_BREAK && k !== KIND_BLOCK) refuse("item kind");
    if (typeof t !== "string") refuse("item text");
    if ((a !== null && typeof a !== "string") || (b !== null && typeof b !== "string")) refuse("item side");
    if (c !== null && typeof c !== "string") refuse("item change");
    const kind = k as ItemKind;
    const text = t as string;
    const sideA = a as string | null;
    const sideB = b as string | null;
    const change = c as string | null;
    if (index === 0) {
      if (kind !== KIND_BLOCK || text !== "" || sideA === null || sideB === null || change !== null) refuse("first item");
    } else if (kind === KIND_BLOCK) {
      if (text !== BLOCK_CHAR || format === "text") refuse("block item");
    } else if (kind === KIND_BREAK) {
      if (text !== BREAK_CHAR || format === "text") refuse("break item");
    } else if (text === "" || (format === "html" && (text.includes(BLOCK_CHAR) || text.includes(BREAK_CHAR)))) {
      refuse("text item");
    }
    if (sideA === null && sideB === null) refuse("item without a side");
    for (const side of [sideA, sideB]) {
      if (side === null) continue;
      if (format === "text" ? side !== "" : !validPresentation(kind, side)) refuse("item presentation");
      if (kind === KIND_BLOCK && side !== "") {
        for (const part of side.split("/")) {
          const id = part.slice(part.indexOf(":") + 1);
          if (id.length > 8) refuse("block id");
          maxBlock = Math.max(maxBlock, Number.parseInt(id, 36) || 0);
        }
      }
    }
    const pending = sideA === null || sideB === null;
    if (pending !== (change !== null)) refuse("item change");
    if (change !== null) {
      const record = changes.get(change);
      if (!record) refuse("item change id");
      const onB = (record as ChangeRecord).kind === "insert" || (record as ChangeRecord).kind === "moveTo";
      if (onB !== (sideA === null)) refuse("item change side");
      used.add(change);
    }
    length += text.length;
    if (length > 2 * MAX_REDLINE_LENGTH) refuse("size");
    items.push({ k: kind, t: text, a: sideA, b: sideB, c: change });
  });
  let maxChange = 0;
  for (const change of changes.values()) {
    if (!used.has(change.id)) refuse("change without text");
    const isMove = change.kind === "moveFrom" || change.kind === "moveTo";
    if (isMove && change.pairedWith === null) refuse("move without its pair");
    maxChange = Math.max(maxChange, Number.parseInt(change.id.slice(1), 10));
  }
  if (!isCount(raw.nextChange) || raw.nextChange <= maxChange) refuse("nextChange");
  if (!isCount(raw.nextBlock)) refuse("nextBlock");
  if (typeof raw.accepted !== "boolean") refuse("accepted");
  return {
    format: format as DocData["format"],
    items,
    changes: [...changes.values()],
    nextChange: raw.nextChange as number,
    nextBlock: Math.max(raw.nextBlock as number, maxBlock + 1),
    accepted: raw.accepted as boolean,
  };
}
