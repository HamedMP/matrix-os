/** `replaceRange`: a deletion followed by an insertion, as a whole or word by word. */

import type { RunFormat, TextPosition } from "../../api/docx-model.js";
import type { XmlElement } from "../../api/xml.js";
import { OfficeError } from "../../errors.js";
import { diffWords } from "../../redline/index.js";
import type { ResolvedPosition } from "../internal.js";
import { firstChild, markupToViewOffset, resolvePosition, scanText, viewToMarkupOffset } from "../internal.js";
import { type EditContext, type ResolvedRange, resolveRange } from "./context.js";
import { deleteRange } from "./delete.js";
import { insertTextAt } from "./insert.js";
import { copyRunProps } from "./text.js";

/** Longest text compared word by word; longer replacements are made as a whole. */
const MAX_WORD_DIFF_LENGTH = 200_000;

/**
 * The run properties the replacement takes over: those of the first
 * character that is replaced. `undefined` when the range holds no text, so
 * that the insertion falls back to the text before it.
 */
function replacedProps(range: ResolvedRange): XmlElement | null | undefined {
  if (range.empty) return undefined;
  const atom = range.start.atom;
  if (atom === null || atom.run === null) return undefined;
  const link = atom.context.hyperlink;
  // A replacement that reaches the end of a link lands behind it and must not keep the link style.
  const leavesLink = link !== null && (!range.single || range.end.atom?.context.hyperlink !== link);
  return copyRunProps(firstChild(atom.run, "w:rPr"), leavesLink);
}

/** Replaces a validated range as one unit. Returns the position after the inserted text. */
export function replaceWhole(
  context: EditContext,
  range: ResolvedRange,
  text: string,
  format: Partial<RunFormat> | undefined,
): TextPosition {
  const { index, tracker } = context;
  const baseProps = replacedProps(range);
  const mark = tracker.size;
  const endPin = tracker.pin({ blockId: range.end.record.id, offset: range.end.offset });
  const startPin = tracker.pin({ blockId: range.start.record.id, offset: range.start.offset });
  deleteRange(context, range);
  // Tracked, the deleted text is still there: the new text goes behind it, as a replacement reads.
  const target = tracker.read(endPin) ?? tracker.read(startPin);
  tracker.truncate(mark);
  if (target === null) throw new OfficeError("invalid_operation", "the replaced range left no position to insert at");
  const resolved: ResolvedPosition = resolvePosition(index, target);
  if (text.length === 0) return target;
  return insertTextAt(context, resolved, text, baseProps === undefined ? { format } : { format, baseProps });
}

interface Hunk {
  /** Offsets in the old text. */
  from: number;
  to: number;
  text: string;
}

/**
 * Replaces a range inside one paragraph word by word: only the words that
 * differ between the visible old text and the new text are deleted and
 * inserted. Returns the position at the end of the replaced range.
 */
export function replaceWords(
  context: EditContext,
  range: ResolvedRange,
  text: string,
  format: Partial<RunFormat> | undefined,
): TextPosition {
  const { tracker } = context;
  if (!range.single) {
    throw new OfficeError("invalid_argument", "a word-by-word replacement needs a range inside one paragraph");
  }
  const record = range.start.record;
  const scan = range.start.scan;
  const from = range.start.offset;
  const to = range.end.offset;
  const viewFrom = markupToViewOffset(scan, "final", from);
  const viewTo = markupToViewOffset(scan, "final", to);
  const oldText = scanText(scan, "final").slice(viewFrom, viewTo);
  if (oldText.length === 0 || text.length === 0 || oldText.length + text.length > MAX_WORD_DIFF_LENGTH) {
    return replaceWhole(context, range, text, format);
  }
  const hunks: Hunk[] = [];
  let open: Hunk | null = null;
  for (const op of diffWords(oldText, text, { detectMoves: false })) {
    if (op.type === "equal") {
      open = null;
      continue;
    }
    if (open === null) {
      open = { from: op.aStart, to: op.aStart, text: "" };
      hunks.push(open);
    }
    if (op.type === "delete" || op.type === "moveFrom") open.to = op.aEnd;
    else open.text += op.text;
  }
  const clamp = (offset: number, low: number): number => Math.min(to, Math.max(low, offset));
  const spans = hunks.map((hunk) => {
    const removes = hunk.to > hunk.from;
    const start = clamp(viewToMarkupOffset(scan, "final", viewFrom + hunk.from, removes ? "after" : "before"), from);
    const end = removes ? clamp(viewToMarkupOffset(scan, "final", viewFrom + hunk.to, "before"), start) : start;
    return { start, end, text: hunk.text };
  });
  const mark = tracker.size;
  let caretPin = tracker.pin({ blockId: record.id, offset: to });
  // From the end, so that the offsets of the hunks still to come stay true.
  for (let at = spans.length - 1; at >= 0; at--) {
    const span = spans[at] as { start: number; end: number; text: string };
    const part = resolveRange(context, {
      start: { blockId: record.id, offset: span.start },
      end: { blockId: record.id, offset: span.end },
    });
    const after = replaceWhole(context, part, span.text, format);
    // New text at the very end of the range: the caret belongs behind it.
    if (at === spans.length - 1 && span.end === to) caretPin = tracker.pin(after);
  }
  const caret = tracker.read(caretPin) ?? { blockId: record.id, offset: from };
  tracker.truncate(mark);
  return caret;
}
