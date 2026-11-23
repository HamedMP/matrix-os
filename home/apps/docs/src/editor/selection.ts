/**
 * Reads and writes the DOM selection as engine positions.
 */

import type { TextPosition, TextRange } from "../../../_shared/office-engine/index";
import type { DocumentView } from "./document-view";
import type { ModelIndex } from "./model-index";
import { type DomPoint, domFromOffset, positionFromDom, shownBounds } from "./position-map";
import type { EditorSelection, SelectionTarget } from "./types";

export function toSelection(index: ModelIndex, anchor: TextPosition, focus: TextPosition): EditorSelection {
  const order = index.compare(anchor, focus);
  const backward = order > 0;
  return {
    anchor,
    focus,
    start: backward ? focus : anchor,
    end: backward ? anchor : focus,
    collapsed: order === 0,
    backward,
  };
}

export function sameSelection(a: EditorSelection | null, b: EditorSelection | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.anchor.blockId === b.anchor.blockId &&
    a.anchor.offset === b.anchor.offset &&
    a.focus.blockId === b.focus.blockId &&
    a.focus.offset === b.focus.offset
  );
}

/** The two ends of anything that names a place: a position, a range or an anchor and focus. */
export function endsOf(target: SelectionTarget): { anchor: TextPosition; focus: TextPosition } {
  if ("blockId" in target) return { anchor: target, focus: target };
  if ("anchor" in target) return { anchor: target.anchor, focus: target.focus };
  return { anchor: (target as TextRange).start, focus: (target as TextRange).end };
}

/** The selection of the document the view is in, when both ends are inside the editing surface. */
export function readSelection(view: DocumentView, index: ModelIndex): EditorSelection | null {
  const selection = view.content.ownerDocument.getSelection();
  if (selection === null || selection.rangeCount === 0) return null;
  const { anchorNode, focusNode } = selection;
  if (anchorNode === null || focusNode === null) return null;
  const anchor = positionFromDom(view.content, anchorNode, selection.anchorOffset);
  const focus = positionFromDom(view.content, focusNode, selection.focusOffset);
  if (anchor === null || focus === null) return null;
  return toSelection(index, anchor, focus);
}

/**
 * The DOM point of a position. A position in a paragraph the view does not
 * show goes to the start of the next shown paragraph, or the end of the one
 * before.
 */
export function domPointOf(view: DocumentView, index: ModelIndex, position: TextPosition): DomPoint | null {
  const shown = view.element(position.blockId);
  if (shown !== null) return domFromOffset(shown, position.offset);
  const entry = index.entry(position.blockId);
  if (entry === null) return null;
  for (let at = entry.order + 1; at < index.paragraphs.length; at++) {
    const candidate = index.paragraphs[at];
    if (candidate === undefined || candidate.storyId !== entry.storyId) break;
    const element = view.element(candidate.id);
    if (element !== null) return domFromOffset(element, shownBounds(element).start);
  }
  for (let at = entry.order - 1; at >= 0; at--) {
    const candidate = index.paragraphs[at];
    if (candidate === undefined || candidate.storyId !== entry.storyId) break;
    const element = view.element(candidate.id);
    if (element !== null) return domFromOffset(element, shownBounds(element).end);
  }
  return null;
}

/** Moves the DOM selection. Returns false when an end cannot be shown. */
export function writeSelection(view: DocumentView, index: ModelIndex, anchor: TextPosition, focus: TextPosition): boolean {
  const selection = view.content.ownerDocument.getSelection();
  if (selection === null) return false;
  const from = domPointOf(view, index, anchor);
  const to = domPointOf(view, index, focus);
  if (from === null || to === null) return false;
  selection.setBaseAndExtent(from.node, from.offset, to.node, to.offset);
  return true;
}

/** A DOM range over an engine range, or null when an end cannot be shown. */
export function domRangeOf(view: DocumentView, index: ModelIndex, range: TextRange): Range | null {
  const from = domPointOf(view, index, range.start);
  const to = domPointOf(view, index, range.end);
  if (from === null || to === null) return null;
  const domRange = view.content.ownerDocument.createRange();
  domRange.setStart(from.node, from.offset);
  domRange.setEnd(to.node, to.offset);
  return domRange;
}

/**
 * A selection with its offsets clamped to the paragraphs as they are now, or
 * null when a paragraph of it is gone. `lengthOf` gives the markup text
 * length of a paragraph, or null when the id is not a paragraph any more.
 */
export function clampSelection(index: ModelIndex, selection: EditorSelection, lengthOf: (blockId: string) => number | null): EditorSelection | null {
  const clamp = (position: TextPosition): TextPosition | null => {
    const length = lengthOf(position.blockId);
    return length === null ? null : { blockId: position.blockId, offset: Math.min(position.offset, length) };
  };
  const anchor = clamp(selection.anchor);
  const focus = clamp(selection.focus);
  return anchor === null || focus === null ? null : toSelection(index, anchor, focus);
}
