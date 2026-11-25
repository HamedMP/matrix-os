/**
 * Agent document edits resolved against a document: `ToDocxOps` in
 * `../api/agent.ts`.
 *
 * Text is quoted from a description, so it is found in the one-line `final`
 * text of its paragraph and mapped back to markup positions. Only the words
 * that differ are replaced: text the agent repeated around its change, and
 * inline objects next to it, are left alone.
 */

import type { AgentCommentEdit, AgentDocxEdit, AgentReplaceTextEdit, RejectedEdit, RejectedEditCode, ToDocxOps } from "../api/agent.js";
import type {
  ApplyOptions,
  BlockId,
  DocxDocument,
  DocxOp,
  InsertParagraphAfterOp,
  InsertParagraphBeforeOp,
  ParagraphBlock,
  TextRange,
} from "../api/docx.js";
import { isOfficeError } from "../errors.js";
import { STARTS_WITH_LENGTH } from "./limits.js";
import { type FinalText, type FlatBlock, commonEnds, flattenStories, occurrences, paragraphFinalText, singleLine } from "./text.js";

/**
 * Order of the operations on one block; lower runs first. New paragraphs
 * come first because they are placed by block id and the block may be
 * deleted by a later operation; comments come before text changes because
 * they do not move text and so can use the offsets the plan was made with.
 */
const PHASE = { insertAfter: 0, insertBefore: 1, comment: 2, text: 3 } as const;

interface Planned {
  editIndex: number;
  op: DocxOp;
  /** Document order of the block the operation is tied to. */
  order: number;
  phase: number;
  /** Start of the text the operation changes, in markup coordinates. */
  offset: number;
  /** End of that text; equal to `offset` for an insertion. */
  end: number;
  blockId: BlockId;
  /** True for an operation that changes or removes the text of its paragraph. */
  touchesText: boolean;
  removesBlock: boolean;
}

class Rejection {
  constructor(
    readonly code: RejectedEditCode,
    readonly message: string,
  ) {}
}

function reject(code: RejectedEditCode, message: string): never {
  throw new Rejection(code, message);
}

/** Text as it is written to a document: line endings as `\n`. */
function insertable(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function paragraphOf(entry: FlatBlock | undefined, what: string): ParagraphBlock {
  if (entry === undefined) reject("not_found", "no block has that id");
  if (entry.block.type !== "paragraph") reject("invalid_operation", `${what} needs a paragraph, not a ${entry.block.type}`);
  return entry.block;
}

/** The match the edit means, as a range of the one-line final text. */
function locate(final: FinalText, quoted: string, occurrence: number | undefined): { start: number; end: number } {
  const needle = singleLine(insertable(quoted));
  const found = occurrences(final.text, needle);
  if (found.length === 0) reject("stale_reference", "the quoted text is not in the paragraph");
  if (occurrence === undefined) {
    if (found.length > 1) reject("ambiguous", `the quoted text occurs ${found.length} times; give an occurrence`);
    return { start: found[0] as number, end: (found[0] as number) + needle.length };
  }
  const start = found[occurrence - 1];
  if (start === undefined) reject("stale_reference", `the quoted text occurs ${found.length} times, not ${occurrence}`);
  return { start, end: start + needle.length };
}

/** The markup range of the final-text characters `start` to `end` (exclusive, not empty). */
function markupRange(blockId: BlockId, final: FinalText, start: number, end: number): TextRange {
  return {
    start: { blockId, offset: final.offsets[start] as number },
    end: { blockId, offset: (final.offsets[end - 1] as number) + 1 },
  };
}

/** The markup position between the final-text characters `index - 1` and `index`. */
function markupPoint(final: FinalText, index: number): number {
  if (index > 0) return (final.offsets[index - 1] as number) + 1;
  return final.offsets[0] ?? final.markupLength;
}

function planReplace(edit: AgentReplaceTextEdit, block: ParagraphBlock): Pick<Planned, "op" | "offset" | "end"> {
  const final = paragraphFinalText(block);
  const match = locate(final, edit.find, edit.occurrence);
  const before = final.text.slice(match.start, match.end);
  const after = insertable(edit.replace);
  // Compared on one line, as the agent saw it; the new text keeps its own line breaks.
  const ends = commonEnds(before, singleLine(after));
  if (ends.prefix === before.length && before.length === after.length) reject("invalid_operation", "the new text is the same as the old text");
  const start = match.start + ends.prefix;
  const end = match.end - ends.suffix;
  const text = after.slice(ends.prefix, after.length - ends.suffix);
  if (start === end) {
    const at = markupPoint(final, start);
    const point = { blockId: block.id, offset: at };
    return { op: { type: "replaceRange", range: { start: point, end: point }, text, granularity: "words" }, offset: at, end: at };
  }
  const range = markupRange(block.id, final, start, end);
  if (spansObject(block, range.start.offset, range.end.offset)) {
    reject("invalid_operation", "the text to change spans an image, note mark or other inline object; change the text on one side of it");
  }
  return { op: { type: "replaceRange", range, text, granularity: "words" }, offset: range.start.offset, end: range.end.offset };
}

/** True when a live (not deleted) inline object lies inside the markup range. */
function spansObject(block: ParagraphBlock, start: number, end: number): boolean {
  for (const run of block.runs) {
    if (run.object === null || run.start < start || run.start >= end) continue;
    const kind = run.revision?.kind;
    if (kind !== "delete" && kind !== "moveFrom") return true;
  }
  return false;
}

function planComment(edit: AgentCommentEdit, block: ParagraphBlock): Pick<Planned, "op" | "offset" | "end"> {
  const final = paragraphFinalText(block);
  if (final.text.length === 0) reject("invalid_operation", "an empty paragraph cannot hold a comment");
  const match = edit.find === "" ? { start: 0, end: final.text.length } : locate(final, edit.find, edit.occurrence);
  const range = markupRange(block.id, final, match.start, match.end);
  return { op: { type: "addComment", range, text: insertable(edit.text) }, offset: range.start.offset, end: range.end.offset };
}

function planEdit(edit: AgentDocxEdit, index: number, blocks: ReadonlyMap<BlockId, FlatBlock>): Planned {
  const entry = blocks.get(edit.blockId);
  const base = { editIndex: index, order: entry?.order ?? 0, blockId: edit.blockId, touchesText: false, removesBlock: false };
  switch (edit.op) {
    case "replaceText":
      return { ...base, ...planReplace(edit, paragraphOf(entry, "replaceText")), phase: PHASE.text, touchesText: true };
    case "comment":
      return { ...base, ...planComment(edit, paragraphOf(entry, "comment")), phase: PHASE.comment };
    case "deleteParagraph": {
      const block = paragraphOf(entry, "deleteParagraph");
      const final = paragraphFinalText(block).text;
      const proof = singleLine(insertable(edit.startsWith));
      if (!final.startsWith(proof) || proof.length < Math.min(STARTS_WITH_LENGTH, final.length)) {
        reject("stale_reference", "startsWith is not the start of the paragraph");
      }
      const op: DocxOp = { type: "deleteParagraph", blockId: block.id };
      return { ...base, op, phase: PHASE.text, offset: 0, end: block.text.length, touchesText: true, removesBlock: true };
    }
    case "insertParagraph": {
      if (entry === undefined) reject("not_found", "no block has that id");
      const neighbour = entry.block;
      if (neighbour.type === "sectionBreak") reject("invalid_operation", "a paragraph cannot be placed against a section break");
      const before = edit.position === "before";
      const op: InsertParagraphAfterOp | InsertParagraphBeforeOp = {
        type: before ? "insertParagraphBefore" : "insertParagraphAfter",
        blockId: neighbour.id,
        text: insertable(edit.text),
      };
      if (edit.headingLevel !== undefined) op.style = { headingLevel: edit.headingLevel };
      // Body text placed against a heading must not become a heading itself.
      else if (neighbour.type === "paragraph" && neighbour.style.headingLevel > 0) op.style = { headingLevel: 0 };
      return { ...base, op, phase: before ? PHASE.insertBefore : PHASE.insertAfter, offset: 0, end: 0 };
    }
  }
}

/** Removes operations that cannot stand next to an earlier edit of the same paragraph. */
function withoutConflicts(planned: readonly Planned[], rejected: RejectedEdit[]): Planned[] {
  const kept: Planned[] = [];
  // Edits per paragraph; bounded by the number of edits in an envelope.
  const byBlock = new Map<BlockId, Planned[]>();
  for (const item of planned) {
    if (!item.touchesText) {
      kept.push(item);
      continue;
    }
    const others = byBlock.get(item.blockId) ?? [];
    const clash = others.find((other) => other.removesBlock || item.removesBlock || overlaps(other, item));
    if (clash !== undefined) {
      rejected.push({
        index: item.editIndex,
        code: "invalid_operation",
        message: `the edit overlaps edit ${clash.editIndex} of the same paragraph`,
      });
      continue;
    }
    others.push(item);
    byBlock.set(item.blockId, others);
    kept.push(item);
  }
  return kept;
}

function overlaps(a: Planned, b: Planned): boolean {
  // Two insertions at one point, or an insertion at the edge of a replaced range, would depend on their order.
  return a.offset <= b.end && b.offset <= a.end;
}

/** From the end of the document to the start, so that no operation moves the target of a later one. */
function applyOrder(a: Planned, b: Planned): number {
  if (a.order !== b.order) return b.order - a.order;
  if (a.phase !== b.phase) return a.phase - b.phase;
  if (a.phase === PHASE.text) return b.offset - a.offset || a.editIndex - b.editIndex;
  // Several paragraphs placed against one block come out in the order the agent gave them.
  return a.phase === PHASE.insertAfter ? b.editIndex - a.editIndex : a.editIndex - b.editIndex;
}

/** Author and date of the trial run; nothing of it is kept. */
const TRIAL: ApplyOptions = { track: true, author: "trial", date: "2000-01-01T00:00:00Z" };

/**
 * Applies the operations one by one and takes everything back, to find the
 * ones the document does not accept. The plan that is returned applies cleanly.
 */
function trial(document: DocxDocument, ordered: readonly Planned[], rejected: RejectedEdit[]): Planned[] {
  if (ordered.length === 0) return [];
  const accepted: Planned[] = [];
  const snapshot = document.snapshot();
  try {
    try {
      // The usual case: everything applies. One call is all or nothing, so a failure leaves the document as it was.
      document.applyOps(
        ordered.map((item) => item.op),
        TRIAL,
      );
      return [...ordered];
    } catch (error) {
      if (!isOfficeError(error)) throw error;
    }
    // Something was refused: find out which operations by applying them one at a time.
    for (const item of ordered) {
      try {
        document.applyOps([item.op], TRIAL);
        accepted.push(item);
      } catch (error) {
        if (!isOfficeError(error)) throw error;
        const code: RejectedEditCode = error.code === "stale_reference" ? "stale_reference" : "invalid_operation";
        rejected.push({ index: item.editIndex, code, message: "the document does not accept this edit" });
      }
    }
  } finally {
    document.restore(snapshot);
  }
  return accepted;
}

export const toDocxOps: ToDocxOps = (document, edits) => {
  const view = document.getView();
  const flat = flattenStories([view.body, ...view.headers, ...view.footers, ...view.footnotes, ...view.endnotes]);
  // One entry per block of the document.
  const blocks = new Map<BlockId, FlatBlock>(flat.map((entry) => [entry.block.id, entry]));
  const rejected: RejectedEdit[] = [];
  const planned: Planned[] = [];
  edits.forEach((edit, index) => {
    try {
      planned.push(planEdit(edit, index, blocks));
    } catch (problem) {
      if (!(problem instanceof Rejection)) throw problem;
      rejected.push({ index, code: problem.code, message: problem.message });
    }
  });
  const ordered = withoutConflicts(planned, rejected).sort(applyOrder);
  const accepted = trial(document, ordered, rejected);
  rejected.sort((a, b) => a.index - b.index);
  return { ops: accepted.map((item) => item.op), opEditIndexes: accepted.map((item) => item.editIndex), rejected };
};
