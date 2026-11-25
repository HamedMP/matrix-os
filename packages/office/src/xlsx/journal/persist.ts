/**
 * Writing the journal into the package: the part `/matrix/changeJournal.json`
 * with its own content type, related from the workbook part. With nothing
 * pending the part and its relationship are removed, so a reviewed file
 * carries no journal.
 */

import type { OpcPackage, Relationship } from "../../api/opc.js";
import type { CellValue } from "../../api/xlsx.js";
import { OfficeError, isOfficeError } from "../../errors.js";
import { partNamesEqual, relativeTargetFor } from "../../opc/index.js";
import type { RawCell } from "../workbook/internals.js";
import type { JournalContext } from "./context.js";
import { parseJournal } from "./parse.js";
import {
  JOURNAL_CONTENT_TYPE,
  JOURNAL_FORMAT_VERSION,
  JOURNAL_PART_NAME,
  JOURNAL_RELATIONSHIP_TYPE,
  type JournalEntry,
  MAX_JOURNAL_TEXT,
} from "./types.js";

type JsonRaw = { value: CellValue; formula: string | null; styleId: number };

function rawJson(raw: RawCell): JsonRaw {
  const value = raw.value !== null && typeof raw.value === "object" ? { kind: "error" as const, code: raw.value.code } : raw.value;
  return { value, formula: raw.formula, styleId: raw.styleId };
}

/** An entry as the journal part holds it. */
export function entryJson(entry: JournalEntry): Record<string, unknown> {
  const base = { kind: entry.kind, id: entry.id, proposalId: entry.proposalId, seq: entry.seq, sheet: entry.sheet };
  switch (entry.kind) {
    case "cell":
      return { ...base, row: entry.row, col: entry.col, old: rawJson(entry.old), new: rawJson(entry.next) };
    case "addSheet":
      return { ...base, name: entry.name };
    case "renameSheet":
      return { ...base, oldName: entry.oldName, newName: entry.newName };
    default:
      return {
        ...base,
        index: entry.index,
        count: entry.count,
        snapshot:
          entry.snapshot === null
            ? null
            : { cells: entry.snapshot.cells.map((cell) => ({ row: cell.row, col: cell.col, raw: rawJson(cell.raw) })), sizes: entry.snapshot.sizes },
        rewrites: entry.rewrites,
        names: entry.names,
        merges: entry.merges,
        features: entry.features,
      };
  }
}

/** The journal part text. Formula cells carry their latest calculated value. */
export function serializeJournal(ctx: JournalContext): string {
  const data = ctx.store.snapshot();
  for (const entry of data.entries) {
    if (entry.kind !== "cell" || entry.next.formula === null || !ctx.internals.hasSheet(entry.sheet)) continue;
    const current = ctx.internals.readRawCell(entry.sheet, { row: entry.row, col: entry.col });
    if (current.formula === entry.next.formula) entry.next = { ...entry.next, value: current.value };
  }
  return JSON.stringify({
    version: JOURNAL_FORMAT_VERSION,
    nextProposal: data.nextProposal,
    nextChange: data.nextChange,
    nextSeq: data.nextSeq,
    proposals: data.proposals,
    changes: data.entries.map(entryJson),
  });
}

/**
 * The journal part text, checked the way the next open reads it. Throws
 * `limit_exceeded` before anything is written when that open would have to
 * ignore it: the pending changes then stay in this handle to be accepted or
 * rejected, instead of being lost with the file.
 */
function readableJournalText(ctx: JournalContext): string {
  let text: string | null = null;
  try {
    text = serializeJournal(ctx);
  } catch (error) {
    // Text longer than a string may be.
    if (!(error instanceof RangeError)) throw error;
  }
  if (text === null || text.length > MAX_JOURNAL_TEXT || !parseJournal(text).ok) {
    throw new OfficeError("limit_exceeded", "the pending changes are too large to save; accept or reject some of them first", {
      details: { maxJournalText: MAX_JOURNAL_TEXT },
    });
  }
  return text;
}

/** True when the relationship points at the journal part. */
export function pointsAtJournal(pkg: OpcPackage, source: string, relationship: Relationship): boolean {
  if (relationship.targetMode !== "Internal") return false;
  try {
    return partNamesEqual(pkg.resolveTarget(source, relationship.target), JOURNAL_PART_NAME);
  } catch (error) {
    // A target that leaves the package is not ours.
    if (isOfficeError(error, "invalid_argument")) return false;
    throw error;
  }
}

/** Writes or removes the journal part. Called by `save()` after recalculation. */
export function writeJournalPart(ctx: JournalContext): void {
  const pkg = ctx.internals.package;
  const source = ctx.internals.workbookPartName;
  const relationships = pkg.getRelationshipsByType(source, JOURNAL_RELATIONSHIP_TYPE);
  if (ctx.store.size === 0) {
    for (const relationship of relationships) pkg.removeRelationship(source, relationship.id);
    if (pkg.hasPart(JOURNAL_PART_NAME)) pkg.removePart(JOURNAL_PART_NAME);
    return;
  }
  pkg.setPart(JOURNAL_PART_NAME, readableJournalText(ctx), JOURNAL_CONTENT_TYPE);
  let linked = false;
  for (const relationship of relationships) {
    if (pointsAtJournal(pkg, source, relationship) && !linked) linked = true;
    else pkg.removeRelationship(source, relationship.id);
  }
  if (!linked) pkg.addRelationship(source, { type: JOURNAL_RELATIONSHIP_TYPE, target: relativeTargetFor(source, JOURNAL_PART_NAME) });
}
