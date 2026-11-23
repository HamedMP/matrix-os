/**
 * Which parts of a paragraph a view mode shows, and where the characters and
 * words a caret can step over are. Everything works on the engine's view
 * model and in its markup coordinates; nothing here reads the DOM.
 */

import type { InlineRun, ParagraphBlock, RevisionKind, TableBlock, TableRow } from "../../../_shared/office-engine/index";
import type { ViewMode } from "./types";

const GONE_IN_FINAL: ReadonlySet<RevisionKind> = new Set<RevisionKind>(["delete", "moveFrom"]);
const GONE_IN_ORIGINAL: ReadonlySet<RevisionKind> = new Set<RevisionKind>(["insert", "moveTo"]);

function gone(kind: RevisionKind | undefined, mode: ViewMode): boolean {
  if (kind === undefined || mode === "markup") return false;
  return mode === "final" ? GONE_IN_FINAL.has(kind) : GONE_IN_ORIGINAL.has(kind);
}

export function runVisible(run: InlineRun, mode: ViewMode): boolean {
  return !gone(run.revision?.kind, mode);
}

export function rowVisible(row: TableRow, mode: ViewMode): boolean {
  return !gone(row.revision?.kind, mode);
}

export function tableVisible(table: TableBlock, mode: ViewMode): boolean {
  return table.rows.some((row) => rowVisible(row, mode));
}

/** True when the view drops the paragraph mark, so the paragraph runs on into the next one. */
export function markRemoved(block: ParagraphBlock, mode: ViewMode): boolean {
  return gone(block.markRevision?.kind, mode);
}

export function hasVisibleContent(block: ParagraphBlock, mode: ViewMode): boolean {
  return block.runs.some((run) => runVisible(run, mode));
}

/** A stretch of markup text, `start` inclusive and `end` exclusive. */
export interface Span {
  start: number;
  end: number;
}

/** The visible stretches of a paragraph in order, neighbours joined. */
export function visibleSpans(block: ParagraphBlock, mode: ViewMode): Span[] {
  const spans: Span[] = [];
  for (const run of block.runs) {
    if (!runVisible(run, mode)) continue;
    const end = run.start + run.text.length;
    const last = spans[spans.length - 1];
    if (last !== undefined && last.end === run.start) last.end = end;
    else spans.push({ start: run.start, end });
  }
  return spans;
}

/** The visible parts of `[from, to)`. */
export function clipToVisible(block: ParagraphBlock, mode: ViewMode, from: number, to: number): Span[] {
  const pieces: Span[] = [];
  for (const span of visibleSpans(block, mode)) {
    const start = Math.max(span.start, from);
    const end = Math.min(span.end, to);
    if (start < end) pieces.push({ start, end });
  }
  return pieces;
}

/** The first offset a caret can take in the view, and the last. */
export function visibleBounds(block: ParagraphBlock, mode: ViewMode): Span {
  const spans = visibleSpans(block, mode);
  const first = spans[0];
  const last = spans[spans.length - 1];
  if (first === undefined || last === undefined) return { start: 0, end: 0 };
  return { start: first.start, end: last.end };
}

/** The visible text with the markup offset of each of its UTF-16 units. */
function visibleText(block: ParagraphBlock, mode: ViewMode): { text: string; offsets: number[] } {
  let text = "";
  const offsets: number[] = [];
  for (const span of visibleSpans(block, mode)) {
    text += block.text.slice(span.start, span.end);
    for (let at = span.start; at < span.end; at++) offsets.push(at);
  }
  return { text, offsets };
}

type SegmenterLike = { segment(text: string): Iterable<{ index: number; segment: string }> };

function graphemeSegmenter(): SegmenterLike | null {
  const intl = Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: string }) => SegmenterLike };
  return typeof intl.Segmenter === "function" ? new intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
}

/** Boundaries between user-perceived characters of `text`, from 0 to `text.length`. */
function characterBoundaries(text: string): number[] {
  const boundaries: number[] = [0];
  const segmenter = graphemeSegmenter();
  if (segmenter !== null) {
    for (const part of segmenter.segment(text)) boundaries.push(part.index + part.segment.length);
    return boundaries;
  }
  for (let at = 0; at < text.length; ) {
    const code = text.codePointAt(at) as number;
    at += code > 0xffff ? 2 : 1;
    boundaries.push(at);
  }
  return boundaries;
}

const WORD_CHARACTER = /[\p{L}\p{N}\p{M}_'’]/u;

/** Index in `text` where the word (with the white space after it) before `at` starts. */
function wordStartBefore(text: string, at: number): number {
  let index = at;
  while (index > 0 && /\s/.test(text[index - 1] as string)) index--;
  if (index > 0 && !WORD_CHARACTER.test(text[index - 1] as string)) return index - 1;
  while (index > 0 && WORD_CHARACTER.test(text[index - 1] as string)) index--;
  return index;
}

function wordEndAfter(text: string, at: number): number {
  let index = at;
  while (index < text.length && /\s/.test(text[index] as string)) index++;
  if (index < text.length && !WORD_CHARACTER.test(text[index] as string)) return index + 1;
  while (index < text.length && WORD_CHARACTER.test(text[index] as string)) index++;
  return index;
}

/** `line` reaches to the edge of the paragraph: the model does not know where lines wrap. */
export type StepUnit = "character" | "word" | "line";

/**
 * The visible text one step before (`backward`) or after a caret, as markup
 * stretches in order. Hidden text between the pieces is not part of them.
 * Empty when the caret is at the visible edge of the paragraph.
 */
export function stepSpans(block: ParagraphBlock, mode: ViewMode, offset: number, direction: "backward" | "forward", unit: StepUnit): Span[] {
  const { text, offsets } = visibleText(block, mode);
  // Index in the visible text of the first visible unit at or after the caret.
  let caret = offsets.findIndex((markup) => markup >= offset);
  if (caret < 0) caret = offsets.length;
  let from: number;
  let to: number;
  if (direction === "backward") {
    if (caret === 0) return [];
    to = caret;
    if (unit === "line") from = 0;
    else if (unit === "word") from = wordStartBefore(text, caret);
    else {
      const boundaries = characterBoundaries(text);
      from = boundaries.filter((boundary) => boundary < caret).pop() ?? 0;
    }
  } else {
    if (caret >= offsets.length) return [];
    from = caret;
    if (unit === "line") to = text.length;
    else if (unit === "word") to = wordEndAfter(text, caret);
    else to = characterBoundaries(text).find((boundary) => boundary > caret) ?? text.length;
  }
  const spans: Span[] = [];
  for (let at = from; at < to; at++) {
    const markup = offsets[at] as number;
    const last = spans[spans.length - 1];
    if (last !== undefined && last.end === markup) last.end = markup + 1;
    else spans.push({ start: markup, end: markup + 1 });
  }
  return spans;
}
