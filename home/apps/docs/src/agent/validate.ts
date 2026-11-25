/**
 * Checks an agent's edits against the live document before anything is
 * applied. The document may have changed while the agent was working, and
 * the agent may quote text slightly wrong or name the wrong paragraph.
 *
 * - An edit must name a block the agent was shown (comment-only review also
 *   allows only comments).
 * - Quoted text must still be in that block. When it is not, it is searched
 *   for in the same clause: exactly, then ignoring typography and case, then
 *   fuzzily. A match rewrites the edit to the exact text at the new place; no
 *   match drops the edit and reports it.
 * - What is left goes through the engine's `toDocxOps`, which refuses what
 *   cannot be applied (ambiguous quotes, overlapping edits, …).
 */

import type { DescribedBlock, DocumentText } from "./description";
import { blockText, clauseOf } from "./description";
import { STARTS_WITH_LENGTH, occurrences, toDocxOps } from "./engine";
import type { AgentDeleteParagraphEdit, AgentDocxEdit, BlockId, DocxDocument } from "./engine";
import { findNormalised, fuzzyFind, normalise } from "./fuzzy";
import type { DroppedEdit, DroppedEditCode, RelocatedEdit } from "./types";

export interface ValidationInput {
  doc: DocxDocument;
  text: DocumentText;
  edits: readonly AgentDocxEdit[];
  /** Blocks the agent was shown. */
  scope: ReadonlySet<BlockId>;
  mode: "edit" | "comment";
  /** 1-based part of the document, for reports. */
  chunk: number;
}

export interface ValidationResult {
  /** Edits that can be applied, rewritten where they were relocated. */
  edits: AgentDocxEdit[];
  /** Index in the agent's answer of each kept edit. */
  indexes: number[];
  dropped: DroppedEdit[];
  relocated: RelocatedEdit[];
}

interface Located {
  blockId: BlockId;
  find: string;
  occurrence: number | undefined;
  how: RelocatedEdit["how"] | "same";
}

/** Blocks of the clause of `blockId`, nearest first, `blockId` itself first. */
function candidates(text: DocumentText, blockId: BlockId): DescribedBlock[] {
  const origin = text.byId.get(blockId);
  if (origin === undefined) return [];
  return clauseOf(text, origin).sort((a, b) => Math.abs(a.order - origin.order) - Math.abs(b.order - origin.order));
}

function occurrenceOf(haystack: string, needle: string, start: number): number | undefined {
  const all = occurrences(haystack, needle);
  if (all.length <= 1) return undefined;
  const index = all.indexOf(start);
  return index < 0 ? undefined : index + 1;
}

/** Where quoted text is now. Null when it cannot be found in the clause. */
function locateQuote(doc: DocxDocument, text: DocumentText, blockId: BlockId, find: string, occurrence: number | undefined): Located | null {
  const own = blockText(doc, blockId);
  if (own !== null && own.includes(find)) return { blockId, find, occurrence, how: "same" };
  const pool = candidates(text, blockId)
    .map((block) => ({ id: block.id, text: blockText(doc, block.id) }))
    .filter((entry): entry is { id: BlockId; text: string } => entry.text !== null);

  for (const entry of pool) {
    if (entry.id !== blockId && entry.text.includes(find)) return { blockId: entry.id, find, occurrence: occurrence !== undefined && occurrences(entry.text, find).length >= occurrence ? occurrence : undefined, how: "exact" };
  }
  for (const entry of pool) {
    const matches = findNormalised(entry.text, find);
    if (matches.length === 0) continue;
    const match = matches[Math.min(matches.length, occurrence ?? 1) - 1] ?? matches[0];
    if (match === undefined) continue;
    const exact = entry.text.slice(match.start, match.end);
    return { blockId: entry.id, find: exact, occurrence: occurrenceOf(entry.text, exact, match.start), how: "normalised" };
  }
  let best: { id: BlockId; text: string; start: number; end: number; score: number } | null = null;
  for (const entry of pool) {
    const match = fuzzyFind(entry.text, find);
    if (match !== null && (best === null || match.score > best.score)) best = { id: entry.id, text: entry.text, ...match };
  }
  if (best === null) return null;
  const exact = best.text.slice(best.start, best.end);
  return { blockId: best.id, find: exact, occurrence: occurrenceOf(best.text, exact, best.start), how: "fuzzy" };
}

function startsWithOf(paragraph: string): string {
  return paragraph.slice(0, STARTS_WITH_LENGTH);
}

/** Where the paragraph a `deleteParagraph` names is now. */
function locateParagraph(doc: DocxDocument, text: DocumentText, edit: AgentDeleteParagraphEdit): Located | null {
  const own = blockText(doc, edit.blockId);
  if (own !== null && startsWithOf(own) === edit.startsWith) return { blockId: edit.blockId, find: edit.startsWith, occurrence: undefined, how: "same" };
  const wanted = normalise(edit.startsWith).text.trim();
  if (wanted === "") return null;
  for (const block of candidates(text, edit.blockId)) {
    const paragraph = blockText(doc, block.id);
    if (paragraph === null || paragraph === "") continue;
    if (normalise(paragraph).text.trim().startsWith(wanted)) {
      return { blockId: block.id, find: startsWithOf(paragraph), occurrence: undefined, how: block.id === edit.blockId ? "normalised" : "exact" };
    }
  }
  return null;
}

export function validateEdits(input: ValidationInput): ValidationResult {
  const { doc, text, scope, chunk } = input;
  const kept: AgentDocxEdit[] = [];
  const indexes: number[] = [];
  const dropped: DroppedEdit[] = [];
  const relocated: RelocatedEdit[] = [];
  const drop = (index: number, edit: AgentDocxEdit, code: DroppedEditCode, message: string) =>
    dropped.push({ chunk, index, op: edit.op, blockId: edit.blockId, code, message });

  input.edits.forEach((edit, index) => {
    const at = `edits[${index}]`;
    if (input.mode === "comment" && edit.op !== "comment") {
      drop(index, edit, "not_allowed", `${at}: only "comment" edits are allowed in this review; no text may change`);
      return;
    }
    if (doc.getBlock(edit.blockId) === null) {
      drop(index, edit, "not_found", `${at}: block ${edit.blockId} does not exist`);
      return;
    }
    if (!scope.has(edit.blockId)) {
      drop(index, edit, "out_of_scope", `${at}: block ${edit.blockId} was not shown to you; use only the block ids in the document text`);
      return;
    }
    let next: AgentDocxEdit = edit;
    let located: Located | null = null;
    if (edit.op === "replaceText" || (edit.op === "comment" && edit.find !== "")) {
      located = locateQuote(doc, text, edit.blockId, edit.find, edit.occurrence);
      if (located === null) {
        drop(index, edit, "stale_reference", `${at}: the quoted "find" text is not in block ${edit.blockId} or its clause; quote the paragraph exactly`);
        return;
      }
      const { occurrence: _old, ...rest } = edit;
      next = { ...rest, blockId: located.blockId, find: located.find, ...(located.occurrence !== undefined ? { occurrence: located.occurrence } : {}) } as AgentDocxEdit;
    } else if (edit.op === "deleteParagraph") {
      located = locateParagraph(doc, text, edit);
      if (located === null) {
        drop(index, edit, "stale_reference", `${at}: "startsWith" is not the start of block ${edit.blockId}; quote its first ${STARTS_WITH_LENGTH} characters exactly`);
        return;
      }
      next = { ...edit, blockId: located.blockId, startsWith: located.find };
    }
    if (located !== null && located.how !== "same") {
      relocated.push({ chunk, index, fromBlockId: edit.blockId, toBlockId: located.blockId, how: located.how });
    }
    kept.push(next);
    indexes.push(index);
  });

  // The engine's own checks; its indexes refer to `kept`.
  const plan = toDocxOps(doc, kept);
  if (plan.rejected.length === 0) return { edits: kept, indexes, dropped, relocated };
  const refused = new Set<number>();
  for (const rejected of plan.rejected) {
    const original = indexes[rejected.index] as number;
    const edit = kept[rejected.index] as AgentDocxEdit;
    refused.add(rejected.index);
    drop(original, edit, rejected.code, `edits[${original}]: ${rejected.message}`);
  }
  dropped.sort((a, b) => a.index - b.index);
  const survivors = kept.filter((_, i) => !refused.has(i));
  const survivorIndexes = indexes.filter((_, i) => !refused.has(i));
  const surviving = new Set(survivorIndexes);
  const keptRelocations = relocated.filter((entry) => surviving.has(entry.index));
  return { edits: survivors, indexes: survivorIndexes, dropped, relocated: keptRelocations };
}
