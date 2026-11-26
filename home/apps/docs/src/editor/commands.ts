/**
 * Editing commands: each one turns an intent (type this, delete backward,
 * split here, paste that) and an engine selection into engine operations,
 * applies them through the session, and returns where the selection belongs
 * afterwards. Commands read the model, never the DOM.
 *
 * In the `final` view text that is a pending deletion is hidden. Commands
 * step over it and leave it alone, so an edit only touches what the owner
 * can see.
 */

import type {
  ApplyResult,
  BlockId,
  DeleteRangeOp,
  DocxOp,
  ParagraphBlock,
  ParagraphStylePatch,
  RunFormat,
  TextPosition,
  TextRange,
} from "../../../_shared/office-engine/index";
import type { DocumentSession } from "../session/index";
import type { ModelIndex } from "./model-index";
import { type PasteContent, cleanText } from "./paste";
import type { ActiveFormat, EditorSelection, ToggleFormat, ViewMode } from "./types";
import { type StepUnit, clipToVisible, hasVisibleContent, markRemoved, runVisible, stepSpans, visibleBounds } from "./visibility";

export const EDITOR_ORIGIN = "editor";
const MAX_JOIN_DEPTH = 256;

/** What a command needs from the editor. */
export interface CommandHost {
  session: DocumentSession;
  index(): ModelIndex;
  mode(): ViewMode;
  /** The current view of a paragraph, or null when the id is not a paragraph. */
  paragraph(id: BlockId): ParagraphBlock | null;
}

/** The selection after a command. Null from a command means it did nothing. */
export interface CommandOutcome {
  anchor: TextPosition;
  focus: TextPosition;
}

function caretAt(position: TextPosition): CommandOutcome {
  return { anchor: position, focus: position };
}

function lastCaret(result: ApplyResult): TextPosition | null {
  for (let at = result.results.length - 1; at >= 0; at--) {
    const caret = result.results[at]?.caret ?? null;
    if (caret !== null) return caret;
  }
  return null;
}

/** The engine ranges that cover a selection, in document order. */
function rangesOf(host: CommandHost, start: TextPosition, end: TextPosition): TextRange[] {
  if (start.blockId === end.blockId) return start.offset < end.offset ? [{ start, end }] : [];
  return host.index().engineRanges({ start, end }, (id) => host.paragraph(id)?.text.length ?? 0);
}

function pieceOp(blockId: BlockId, piece: { start: number; end: number }): DeleteRangeOp {
  return { type: "deleteRange", range: { start: { blockId, offset: piece.start }, end: { blockId, offset: piece.end } } };
}

/**
 * Deletions for one engine range of sibling paragraphs, in document order.
 * When the view hides nothing in its paragraphs it is one deletion. Otherwise
 * each paragraph loses only its visible stretches, and neighbours are joined
 * by deleting just the paragraph mark between them, so hidden text (and a mark
 * the view already drops) stays for review. A table between two siblings is
 * selected whole and goes with the join, as it does in a single deletion.
 */
function visibleDeletes(host: CommandHost, range: TextRange): DeleteRangeOp[] {
  const mode = host.mode();
  const index = host.index();
  const container = index.entry(range.start.blockId)?.containerKey;
  const entries = index.between(range.start.blockId, range.end.blockId).filter((entry) => entry.containerKey === container);
  const ops: DeleteRangeOp[] = [];
  let hidden = false;
  entries.forEach((entry, at) => {
    const block = host.paragraph(entry.id);
    if (block === null) {
      hidden = true;
      return;
    }
    const from = entry.id === range.start.blockId ? range.start.offset : 0;
    const to = entry.id === range.end.blockId ? range.end.offset : block.text.length;
    const pieces = clipToVisible(block, mode, from, to);
    if (pieces.length > 1 || (pieces.length === 1 && (pieces[0]?.start !== from || pieces[0]?.end !== to)) || (pieces.length === 0 && from < to)) hidden = true;
    for (const piece of pieces) ops.push(pieceOp(block.id, piece));
    const next = entries[at + 1];
    if (next === undefined) return;
    if (markRemoved(block, mode)) {
      hidden = true;
      return;
    }
    ops.push({ type: "deleteRange", range: { start: { blockId: block.id, offset: block.text.length }, end: { blockId: next.id, offset: 0 } } });
  });
  return hidden ? ops : [{ type: "deleteRange", range }];
}

/** Deletions for a selection, ordered from the end of the document so each leaves the earlier ones valid. */
function deleteOps(host: CommandHost, start: TextPosition, end: TextPosition): DeleteRangeOp[] {
  if (start.blockId === end.blockId) {
    const block = host.paragraph(start.blockId);
    if (block === null) return [];
    return clipToVisible(block, host.mode(), start.offset, end.offset)
      .reverse()
      .map((piece) => pieceOp(block.id, piece));
  }
  return rangesOf(host, start, end)
    .flatMap((range) => visibleDeletes(host, range))
    .reverse();
}

/** Typing shares an undo step per word: white space starts a new one. */
function typingKey(blockId: BlockId, text: string): string | undefined {
  if (text.length > 8 || text.includes("\n")) return undefined;
  return /^\s+$/.test(text) ? `space:${blockId}` : `type:${blockId}`;
}

/**
 * Deletes a selection that is about to be replaced and returns where the
 * replacement goes: after what is left of the selection. Tracked, the deleted
 * text stays in the document, and the new text follows it as a replacement
 * does; untracked, the place is where the selection was.
 */
function deleteForReplacement(host: CommandHost, selection: EditorSelection): TextPosition {
  const ops = deleteOps(host, selection.start, selection.end);
  if (ops.length === 0) return selection.start;
  const result = host.session.apply(ops, { origin: EDITOR_ORIGIN, positions: [selection.end] });
  return result.positions[0] ?? selection.start;
}

/** Replaces the selection with text. `format` is direct formatting for the new text. */
export function insertText(host: CommandHost, selection: EditorSelection, text: string, format: Partial<RunFormat> | null): CommandOutcome | null {
  const clean = cleanText(text);
  const { start, end } = selection;
  const deletes = selection.collapsed ? [] : deleteOps(host, start, end);
  if (clean === "" && deletes.length === 0) return selection.collapsed ? null : caretAt(start);
  const formatted = format === null || Object.keys(format).length === 0 ? {} : { format };
  let ops: DocxOp[];
  const only = deletes[0];
  if (clean === "") ops = deletes;
  else if (deletes.length === 1 && only !== undefined) ops = [{ type: "replaceRange", range: only.range, text: clean, ...formatted }];
  else if (deletes.length > 1) {
    // Several stretches go (hidden text or a table lies between them): delete, then insert, as one step.
    return host.session.batch(
      () => {
        const at = deleteForReplacement(host, selection);
        const inserted = host.session.apply([{ type: "insertText", at, text: clean, ...formatted }], { origin: EDITOR_ORIGIN });
        return caretAt(lastCaret(inserted) ?? at);
      },
      { origin: EDITOR_ORIGIN },
    );
  } else ops = [{ type: "insertText", at: start, text: clean, ...formatted }];
  const result = host.session.apply(ops, {
    origin: EDITOR_ORIGIN,
    positions: [start],
    // Typing over a selection starts the undo step that the rest of the word joins.
    mergeKey: typingKey(start.blockId, clean),
  });
  const caret = lastCaret(result) ?? result.positions[0] ?? null;
  return caret === null ? null : caretAt(caret);
}

/** Splits the paragraph at the caret, after deleting the selection (the Enter key). */
export function insertParagraph(host: CommandHost, selection: EditorSelection): CommandOutcome | null {
  const { start, end } = selection;
  const deletes = selection.collapsed ? [] : deleteOps(host, start, end);
  const result = host.session.apply([...deletes, { type: "splitParagraph", at: start }], { origin: EDITOR_ORIGIN });
  const caret = lastCaret(result);
  return caret === null ? null : caretAt(caret);
}

export function deleteSelection(host: CommandHost, selection: EditorSelection): CommandOutcome | null {
  if (selection.collapsed) return null;
  const ops = deleteOps(host, selection.start, selection.end);
  if (ops.length === 0) return caretAt(selection.start);
  const result = host.session.apply(ops, { origin: EDITOR_ORIGIN, positions: [selection.start] });
  return caretAt(result.positions[0] ?? selection.start);
}

function deleteAt(host: CommandHost, at: TextPosition, direction: "backward" | "forward", unit: StepUnit, depth: number): CommandOutcome | null {
  const block = host.paragraph(at.blockId);
  if (block === null || depth > MAX_JOIN_DEPTH) return null;
  const mode = host.mode();
  const id = block.id;
  const spans = stepSpans(block, mode, at.offset, direction, unit);
  const first = spans[0];
  const last = spans[spans.length - 1];
  if (first !== undefined && last !== undefined) {
    const ops: DocxOp[] = [...spans].reverse().map((span) => ({
      type: "deleteRange",
      range: { start: { blockId: id, offset: span.start }, end: { blockId: id, offset: span.end } },
    }));
    const result = host.session.apply(ops, {
      origin: EDITOR_ORIGIN,
      positions: [
        { blockId: id, offset: first.start },
        { blockId: id, offset: last.end },
      ],
      mergeKey: `delete-${direction}:${id}`,
    });
    // Tracked, the text stays as a deletion: a forward delete moves past it, a backspace stops before it.
    const caret = result.positions[direction === "backward" ? 0 : 1] ?? null;
    return caret === null ? null : caretAt(caret);
  }
  // At the edge of the paragraph: join it with its neighbour, when that is a paragraph too.
  const index = host.index();
  if (direction === "backward") {
    const before = index.siblingBefore(id);
    const previous = before?.type === "paragraph" ? host.paragraph(before.id) : null;
    if (previous === null) return null;
    const join = { blockId: previous.id, offset: visibleBounds(previous, mode).end };
    // The view already shows the two as one paragraph: continue in the previous one.
    if (markRemoved(previous, mode)) return deleteAt(host, join, direction, unit, depth + 1);
    const range = { start: { blockId: previous.id, offset: previous.text.length }, end: { blockId: id, offset: 0 } };
    const result = host.session.apply([{ type: "deleteRange", range }], { origin: EDITOR_ORIGIN, positions: [join] });
    return caretAt(result.positions[0] ?? join);
  }
  const after = index.siblingAfter(id);
  const next = after?.type === "paragraph" ? host.paragraph(after.id) : null;
  if (next === null) return null;
  const join = { blockId: next.id, offset: visibleBounds(next, mode).start };
  if (markRemoved(block, mode)) return deleteAt(host, join, direction, unit, depth + 1);
  const range = { start: { blockId: id, offset: block.text.length }, end: { blockId: next.id, offset: 0 } };
  const result = host.session.apply([{ type: "deleteRange", range }], { origin: EDITOR_ORIGIN, positions: [join] });
  return caretAt(result.positions[0] ?? join);
}

/**
 * Deletes a range the browser reported for a delete at a caret. Unlike a
 * selection, it has a direction: tracked, a forward delete leaves the caret
 * after the text that stays as a deletion.
 */
export function deleteReported(host: CommandHost, range: EditorSelection, direction: "backward" | "forward"): CommandOutcome | null {
  const ops = deleteOps(host, range.start, range.end);
  if (ops.length === 0) return null;
  const result = host.session.apply(ops, { origin: EDITOR_ORIGIN, positions: [range.start, range.end] });
  const caret = result.positions[direction === "backward" ? 0 : 1] ?? null;
  return caret === null ? null : caretAt(caret);
}

/** Backspace and Delete: removes the selection, or one character, word or line beside the caret. */
export function deleteStep(host: CommandHost, selection: EditorSelection, direction: "backward" | "forward", unit: StepUnit): CommandOutcome | null {
  if (!selection.collapsed) return deleteSelection(host, selection);
  return deleteAt(host, selection.start, direction, unit, 0);
}

/**
 * The ranges to format for a selection the view hides text in: each visible
 * stretch, joined across a paragraph mark the view shows, so hidden text and
 * a hidden mark keep their formatting. Null when the view hides nothing in
 * the selection, which is then formatted as the engine ranges that cover it.
 */
function visibleFormatRanges(host: CommandHost, start: TextPosition, end: TextPosition): TextRange[] | null {
  const mode = host.mode();
  const index = host.index();
  const ranges: TextRange[] = [];
  let hidden = false;
  // The paragraph whose last range reaches its end, before a mark the view shows: the next stretch may continue that range.
  let open: BlockId | null = null;
  for (const entry of index.between(start.blockId, end.blockId)) {
    const block = host.paragraph(entry.id);
    if (block === null) continue;
    const from = entry.id === start.blockId ? start.offset : 0;
    const to = entry.id === end.blockId ? end.offset : block.text.length;
    const pieces = clipToVisible(block, mode, from, to);
    const whole = pieces.length === 1 && pieces[0]?.start === from && pieces[0]?.end === to;
    if (from < to && !whole) hidden = true;
    const previous = ranges[ranges.length - 1];
    const joined = open !== null && previous !== undefined && index.siblingAfter(open)?.id === block.id ? previous : null;
    if (joined !== null && block.text.length === 0) joined.end = { blockId: block.id, offset: 0 };
    pieces.forEach((piece, at) => {
      if (at === 0 && joined !== null && piece.start === 0) joined.end = { blockId: block.id, offset: piece.end };
      else ranges.push({ start: { blockId: block.id, offset: piece.start }, end: { blockId: block.id, offset: piece.end } });
    });
    const last = ranges[ranges.length - 1];
    const reachesEnd = last !== undefined && last.end.blockId === block.id && last.end.offset === block.text.length;
    const markShown = !markRemoved(block, mode);
    if (entry.id !== end.blockId && !markShown) hidden = true;
    open = entry.id !== end.blockId && markShown && reachesEnd ? block.id : null;
  }
  return hidden ? ranges : null;
}

/** Sets character formatting on the selection and keeps the selection. Text the view hides keeps its formatting. */
export function setRunFormat(host: CommandHost, selection: EditorSelection, format: Partial<RunFormat>): CommandOutcome | null {
  const ranges = visibleFormatRanges(host, selection.start, selection.end) ?? rangesOf(host, selection.start, selection.end);
  if (ranges.length === 0) return null;
  const ops: DocxOp[] = ranges.reverse().map((range) => ({ type: "setRunFormat", range, format }));
  const result = host.session.apply(ops, { origin: EDITOR_ORIGIN, positions: [selection.anchor, selection.focus] });
  return { anchor: result.positions[0] ?? selection.anchor, focus: result.positions[1] ?? selection.focus };
}

/**
 * Sets paragraph properties on every paragraph the selection touches that the
 * view shows. A paragraph between its ends that the view hides entirely (a
 * pending deletion of its text and its mark) keeps its properties.
 */
export function setParagraphStyle(host: CommandHost, selection: EditorSelection, style: Partial<ParagraphStylePatch>): CommandOutcome | null {
  const mode = host.mode();
  const { start, end } = selection;
  const entries = host
    .index()
    .between(start.blockId, end.blockId)
    .filter((entry) => {
      if (entry.id === start.blockId || entry.id === end.blockId) return true;
      const block = host.paragraph(entry.id);
      return block !== null && !(markRemoved(block, mode) && !hasVisibleContent(block, mode));
    });
  if (entries.length === 0) return null;
  const ops: DocxOp[] = entries.map((entry) => ({ type: "setParagraphStyle", blockId: entry.id, style }));
  const result = host.session.apply(ops, { origin: EDITOR_ORIGIN, positions: [selection.anchor, selection.focus] });
  return { anchor: result.positions[0] ?? selection.anchor, focus: result.positions[1] ?? selection.focus };
}

/** Replaces the selection with pasted paragraphs as one undo step. */
export function paste(host: CommandHost, selection: EditorSelection, content: PasteContent): CommandOutcome | null {
  return host.session.batch(
    () => {
      let caret = selection.collapsed ? selection.start : deleteForReplacement(host, selection);
      content.paragraphs.forEach((segments, at) => {
        if (at > 0) {
          const split = host.session.apply([{ type: "splitParagraph", at: caret }], { origin: EDITOR_ORIGIN });
          caret = lastCaret(split) ?? caret;
        }
        const ops: DocxOp[] = [];
        let offset = caret.offset;
        for (const segment of segments) {
          const format = content.formatted ? { format: { bold: segment.bold, italic: segment.italic, underline: segment.underline } } : {};
          ops.push({ type: "insertText", at: { blockId: caret.blockId, offset }, text: segment.text, ...format });
          offset += segment.text.length;
        }
        if (ops.length === 0) return;
        const inserted = host.session.apply(ops, { origin: EDITOR_ORIGIN });
        caret = lastCaret(inserted) ?? { blockId: caret.blockId, offset };
      });
      return caretAt(caret);
    },
    { origin: EDITOR_ORIGIN },
  );
}

/** The visible runs of the paragraphs a selection touches, clipped to it. */
function selectedRuns(host: CommandHost, selection: EditorSelection): Array<{ block: ParagraphBlock; format: RunFormat; text: string }> {
  const mode = host.mode();
  const runs: Array<{ block: ParagraphBlock; format: RunFormat; text: string }> = [];
  for (const entry of host.index().between(selection.start.blockId, selection.end.blockId)) {
    const block = host.paragraph(entry.id);
    if (block === null) continue;
    const from = entry.id === selection.start.blockId ? selection.start.offset : 0;
    const to = entry.id === selection.end.blockId ? selection.end.offset : block.text.length;
    for (const run of block.runs) {
      if (!runVisible(run, mode)) continue;
      const start = Math.max(from, run.start);
      const end = Math.min(to, run.start + run.text.length);
      if (start < end) runs.push({ block, format: run, text: run.text.slice(start - run.start, end - run.start) });
    }
  }
  return runs;
}

/** The value a toggle should set: off when the whole selection already has the property, else on. */
export function toggleValue(host: CommandHost, selection: EditorSelection, name: ToggleFormat): boolean {
  const runs = selectedRuns(host, selection);
  return !(runs.length > 0 && runs.every((run) => run.format[name]));
}

/** Formatting at the selection, for toolbar state. `pending` is the format armed for the next typed text. */
export function activeFormat(host: CommandHost, selection: EditorSelection, pending: Partial<RunFormat> | null): ActiveFormat | null {
  const first = host.paragraph(selection.start.blockId);
  if (first === null) return null;
  const flags = { bold: false, italic: false, underline: false, strike: false };
  if (selection.collapsed) {
    const mode = host.mode();
    const visible = first.runs.filter((run) => runVisible(run, mode));
    // A caret takes the formatting of the text before it, as the engine does for inserted text.
    const run =
      visible.filter((candidate) => candidate.start < selection.start.offset).pop() ?? visible.find((candidate) => candidate.start >= selection.start.offset);
    if (run !== undefined) Object.assign(flags, { bold: run.bold, italic: run.italic, underline: run.underline, strike: run.strike });
    for (const name of ["bold", "italic", "underline", "strike"] as const) {
      const value = pending?.[name];
      if (value !== undefined) flags[name] = value;
    }
  } else {
    const runs = selectedRuns(host, selection);
    for (const name of ["bold", "italic", "underline", "strike"] as const) flags[name] = runs.length > 0 && runs.every((run) => run.format[name]);
  }
  const blocks = host
    .index()
    .between(selection.start.blockId, selection.end.blockId)
    .map((entry) => host.paragraph(entry.id))
    .filter((block): block is ParagraphBlock => block !== null);
  const same = <T>(pick: (block: ParagraphBlock) => T): T | null => {
    const value = pick(first);
    return blocks.every((block) => pick(block) === value) ? value : null;
  };
  return {
    ...flags,
    headingLevel: same((block) => block.style.headingLevel),
    alignment: same((block) => block.style.alignment),
    styleName: same((block) => block.style.styleName),
    inTable: host.index().entry(selection.start.blockId)?.tableId != null,
  };
}

/** The selected text as the view shows it; paragraphs are separated by `\n`, inline objects left out. */
export function selectedText(host: CommandHost, selection: EditorSelection): string {
  if (selection.collapsed) return "";
  const lines = new Map<BlockId, string>();
  for (const entry of host.index().between(selection.start.blockId, selection.end.blockId)) lines.set(entry.id, "");
  for (const run of selectedRuns(host, selection)) lines.set(run.block.id, (lines.get(run.block.id) ?? "") + run.text.replace(/￼/g, ""));
  return [...lines.values()].join("\n");
}

/**
 * Where Tab goes from a paragraph in a table: the first paragraph of the next
 * cell, or of the previous one. Null at the first or last cell, undefined
 * outside a table.
 */
export function adjacentCell(index: ModelIndex, blockId: BlockId, backward: boolean): TextPosition | null | undefined {
  const cells = index.tableParagraphs(blockId);
  const here = index.entry(blockId);
  if (here === null || cells.length === 0) return undefined;
  const others = cells.filter((entry) => entry.containerKey !== here.containerKey && (backward ? entry.order < here.order : entry.order > here.order));
  // Backward lands on the first paragraph of the previous cell.
  const previousCell = others[others.length - 1]?.containerKey;
  const target = backward ? others.find((entry) => entry.containerKey === previousCell) : others[0];
  return target === undefined ? null : { blockId: target.id, offset: 0 };
}
