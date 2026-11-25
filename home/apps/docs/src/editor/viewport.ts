/**
 * Scrolling and geometry: bringing a place in the document into view, keeping
 * the caret in view after an edit, and the rectangles of a range.
 *
 * The editor cancels the browser's own input handling, so the browser does
 * not scroll to the caret by itself; `revealCaret` does it after every edit.
 */

import type { BlockId, TextRange } from "../../../_shared/office-engine/index";
import type { DocumentView } from "./document-view";
import type { ModelIndex } from "./model-index";
import { domPointOf, domRangeOf, endsOf } from "./selection";
import type { ScrollOptions, SelectionTarget } from "./types";

/** Space kept between the caret and the edge of the scrolling area, in CSS pixels. */
const CARET_MARGIN = 24;

function elementOfNode(node: Node): Element | null {
  return node.nodeType === 1 ? (node as Element) : node.parentElement;
}

/** Scrolls a block or a place into view. False when the view does not show it. */
export function scrollIntoView(view: DocumentView, index: ModelIndex, target: BlockId | SelectionTarget, options: ScrollOptions): boolean {
  let element: Element | null;
  if (typeof target === "string") element = view.element(target);
  else {
    const point = domPointOf(view, index, endsOf(target).focus);
    element = point === null ? null : elementOfNode(point.node);
  }
  if (element === null) return false;
  if (typeof element.scrollIntoView === "function") element.scrollIntoView({ behavior: options.behavior ?? "auto", block: options.block ?? "center" });
  return true;
}

/** Client rectangles of a range; empty when it is not shown or the environment has no layout. */
export function rangeRects(view: DocumentView, index: ModelIndex, range: TextRange): DOMRect[] {
  const domRange = domRangeOf(view, index, range);
  if (domRange === null || typeof domRange.getClientRects !== "function") return [];
  return Array.from(domRange.getClientRects());
}

/** Scrolls `scroller` just far enough that the caret of the DOM selection is inside it. */
export function revealCaret(scroller: HTMLElement): void {
  const selection = scroller.ownerDocument.getSelection();
  const node = selection?.focusNode ?? null;
  if (selection === null || node === null || !scroller.contains(node)) return;
  const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  let rect = range !== null && typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : null;
  // A caret in an empty line has no rectangle of its own in some browsers: use its element.
  if (rect === null || (rect.width === 0 && rect.height === 0 && rect.top === 0)) rect = elementOfNode(node)?.getBoundingClientRect() ?? null;
  if (rect === null) return;
  const bounds = scroller.getBoundingClientRect();
  if (bounds.height === 0) return;
  if (rect.bottom > bounds.bottom - CARET_MARGIN) scroller.scrollTop += rect.bottom - (bounds.bottom - CARET_MARGIN);
  else if (rect.top < bounds.top + CARET_MARGIN) scroller.scrollTop -= bounds.top + CARET_MARGIN - rect.top;
}
