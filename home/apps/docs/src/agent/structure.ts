/**
 * Fix numbering and cross-references: deterministic, no model involved.
 *
 * Typed clause numbers (`1.`, `4.2`, `(a)`) are checked in document order:
 * decimal numbers must count up within their parent, and a run of `(a)`,
 * `(i)` or `(1)` labels must count from the first. A wrong number is
 * replaced. A typed cross-reference ("clause 4.2") whose target paragraph
 * gets a new number is updated to it; a reference that points nowhere gets a
 * comment. Everything is applied as tracked changes by the assistant.
 * Automatic (list) numbering is computed by the engine and left alone.
 */

import { ASSISTANT_AUTHOR, MESSAGES } from "./constants";
import { flattenStories, isOfficeError, occurrences, paragraphFinalText, toDocxOps } from "./engine";
import type { AgentDocxEdit, BlockId, DocxDocument, ParagraphBlock } from "./engine";
import { defaultLog } from "./model";
import { summariseChanges, summariseComments } from "./summary";
import type { DocumentSession } from "../session/index";
import type { ChangeSummaryItem, CommentSummaryItem } from "./types";

export interface LabelChange {
  blockId: BlockId;
  from: string;
  to: string;
}

export interface StructurePlan {
  edits: AgentDocxEdit[];
  labelChanges: LabelChange[];
  /** Cross-references updated to a renumbered target. */
  updatedReferences: number;
  /** Cross-references that point to no paragraph; each gets a comment. */
  brokenReferences: number;
}

const DECIMAL = /^(\d{1,3}(?:\.\d{1,3}){0,3})(\.?)(?=[\t ])/;
const PAREN = /^\(([a-z]{1,4}|[A-Z]{1,4}|\d{1,3})\)(?=[\t ])/;
const ROMAN = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii", "xiii", "xiv", "xv", "xvi", "xvii", "xviii", "xix", "xx"];

type ParenKind = "digit" | "lower" | "upper" | "roman" | "ROMAN";

function parenKind(label: string, next: string | null): ParenKind {
  if (/^\d+$/.test(label)) return "digit";
  const lower = label === label.toLowerCase();
  // `(i)` followed by `(ii)` is roman; `(i)` after `(h)` is a letter (handled by the run).
  if (label.toLowerCase() === "i" && next !== null && next.toLowerCase() === "ii") return lower ? "roman" : "ROMAN";
  return lower ? "lower" : "upper";
}

function parenLabel(kind: ParenKind, n: number): string | null {
  switch (kind) {
    case "digit":
      return String(n);
    case "lower":
    case "upper": {
      if (n > 26) return null;
      const letter = String.fromCharCode(96 + n);
      return kind === "lower" ? letter : letter.toUpperCase();
    }
    default: {
      const roman = ROMAN[n - 1];
      if (roman === undefined) return null;
      return kind === "roman" ? roman : roman.toUpperCase();
    }
  }
}

function sameFamily(a: ParenKind, b: ParenKind): boolean {
  const family = (kind: ParenKind) => (kind === "roman" || kind === "lower" ? "lower" : kind === "ROMAN" || kind === "upper" ? "upper" : "digit");
  return family(a) === family(b);
}

interface Para {
  block: ParagraphBlock;
  text: string;
}

/** Body paragraphs outside tables, in order, without automatic numbering. */
function bodyParagraphs(doc: DocxDocument): Para[] {
  const view = doc.getView();
  return flattenStories([view.body])
    .filter((entry) => entry.place === null && entry.block.type === "paragraph")
    .map((entry) => entry.block as ParagraphBlock)
    .filter((block) => block.numbering === null)
    .map((block) => ({ block, text: paragraphFinalText(block).text }));
}

/** Wrong typed numbers and what they should be. */
export function findLabelChanges(doc: DocxDocument): LabelChange[] {
  const paragraphs = bodyParagraphs(doc);
  const changes: LabelChange[] = [];
  const counters: number[] = [];
  let seenTop = false;
  let run: { kind: ParenKind; count: number } | null = null;

  paragraphs.forEach((para, index) => {
    const decimal = DECIMAL.exec(para.text);
    const paren = decimal === null ? PAREN.exec(para.text) : null;
    if (paren === null && para.text.trim() !== "") run = null;
    if (decimal !== null) {
      const parts = (decimal[1] as string).split(".").map(Number);
      const depth = parts.length;
      // A single number needs its dot ("4."), so a year or an amount at the start is not a label.
      if (depth === 1 && decimal[2] !== ".") return;
      const expected = parts.slice();
      if (depth === 1) {
        expected[0] = seenTop ? (counters[0] ?? 0) + 1 : (parts[0] as number);
        seenTop = true;
      } else {
        for (let level = 0; level < depth - 1; level++) {
          if ((counters[level] ?? 0) > 0) expected[level] = counters[level] as number;
        }
        const parentsMatch = expected.slice(0, depth - 1).every((value, level) => value === (counters[level] ?? value));
        expected[depth - 1] = parentsMatch && (counters[depth - 1] ?? 0) > 0 ? (counters[depth - 1] as number) + 1 : 1;
      }
      counters.length = depth;
      expected.forEach((value, level) => (counters[level] = value));
      const to = expected.join(".");
      if (to !== decimal[1]) changes.push({ blockId: para.block.id, from: decimal[1] as string, to });
      return;
    }
    if (paren !== null) {
      const label = paren[1] as string;
      const nextText = paragraphs[index + 1]?.text ?? "";
      const next = PAREN.exec(nextText)?.[1] ?? null;
      if (run === null || !sameFamily(run.kind, parenKind(label, next))) run = { kind: parenKind(label, next), count: 0 };
      run.count++;
      const to = parenLabel(run.kind, run.count);
      if (to !== null && to !== label) changes.push({ blockId: para.block.id, from: `(${label})`, to: `(${to})` });
    }
  });
  return changes;
}

/** Final-view offset of a markup offset in a paragraph. */
function finalOffset(block: ParagraphBlock, markupOffset: number): number {
  const { offsets } = paragraphFinalText(block);
  let index = 0;
  while (index < offsets.length && (offsets[index] as number) < markupOffset) index++;
  return index;
}

export function planStructureFixes(doc: DocxDocument): StructurePlan {
  const labelChanges = findLabelChanges(doc);
  const edits: AgentDocxEdit[] = labelChanges.map((change) => ({ op: "replaceText", blockId: change.blockId, find: change.from, replace: change.to, occurrence: 1 }));
  const newLabel = new Map<BlockId, LabelChange>(labelChanges.filter((change) => !change.from.startsWith("(")).map((change) => [change.blockId, change]));
  let updatedReferences = 0;
  let brokenReferences = 0;
  for (const reference of doc.getCrossReferences()) {
    if (reference.source !== "text") continue;
    const block = doc.getBlock(reference.blockId);
    if (block === null || block.type !== "paragraph") continue;
    const text = paragraphFinalText(block).text;
    const at = finalOffset(block, reference.range.start.offset);
    const all = occurrences(text, reference.text);
    const position = all.indexOf(at);
    const occurrence = position < 0 ? 1 : position + 1;
    if (reference.broken) {
      brokenReferences++;
      edits.push({ op: "comment", blockId: reference.blockId, find: reference.text, occurrence, text: `This reference (${reference.text}) does not match any numbered clause. Check the clause number.` });
      continue;
    }
    const change = reference.targetBlockId !== null ? newLabel.get(reference.targetBlockId) : undefined;
    if (change === undefined || !reference.text.includes(change.from)) continue;
    const replaced = reference.text.replace(new RegExp(`(^|[^\\d.])${change.from.replace(/\./g, "\\.")}(?![\\d]|\\.\\d)`), (_match, lead: string) => `${lead}${change.to}`);
    if (replaced === reference.text) continue;
    updatedReferences++;
    edits.push({ op: "replaceText", blockId: reference.blockId, find: reference.text, replace: replaced, occurrence });
  }
  return { edits, labelChanges, updatedReferences, brokenReferences };
}

export type StructureFixResult =
  | {
      status: "applied";
      revisionIds: string[];
      changes: ChangeSummaryItem[];
      comments: CommentSummaryItem[];
      labelChanges: LabelChange[];
      updatedReferences: number;
      brokenReferences: number;
    }
  | { status: "no_changes" }
  | { status: "failed"; message: string };

/** Finds and applies the fixes as tracked changes, as one undo step. */
export function fixNumberingAndReferences(
  session: DocumentSession,
  options: { author?: string; log?: (message: string, error: unknown) => void } = {},
): StructureFixResult {
  const doc = session.document;
  if (doc === null) return { status: "failed", message: MESSAGES.no_document };
  const plan = planStructureFixes(doc);
  if (plan.edits.length === 0) return { status: "no_changes" };
  const { ops, rejected } = toDocxOps(doc, plan.edits);
  for (const entry of rejected) (options.log ?? defaultLog)("docs assistant: a numbering fix was skipped", entry.code);
  if (ops.length === 0) return { status: "no_changes" };
  try {
    const result = session.apply(ops, { track: true, author: options.author ?? ASSISTANT_AUTHOR, origin: "agent" });
    const commentIds = result.results.map((entry) => entry.commentId).filter((id): id is string => id !== null);
    return {
      status: "applied",
      revisionIds: result.revisionIds,
      changes: summariseChanges(doc, result.revisionIds),
      comments: summariseComments(doc, commentIds),
      labelChanges: plan.labelChanges,
      updatedReferences: plan.updatedReferences,
      brokenReferences: plan.brokenReferences,
    };
  } catch (error) {
    (options.log ?? defaultLog)("docs assistant: applying numbering fixes failed", isOfficeError(error) ? error.code : error);
    return { status: "failed", message: MESSAGES.apply_failed };
  }
}
