/**
 * Translates between DOM boundary points and engine positions.
 *
 * It reads only the structure the renderer wrote: paragraph elements
 * (`data-block-id`) and their leaves (`data-s` start and `data-l` length in
 * the paragraph's markup text). The text content of the DOM is never used to
 * decide what the document says; it only bounds an offset inside a leaf.
 *
 * Text the current view hides has no leaf. A position inside hidden text maps
 * to the nearest shown boundary, and a DOM point between two leaves maps to
 * the start of the leaf after it.
 */

import type { TextPosition } from "../../../_shared/office-engine/index";
import { BLOCK_ID, BLOCK_TYPE, FILLER, LEAF_ATOM, LEAF_LENGTH, LEAF_START } from "./render-paragraph";

export interface DomPoint {
  node: Node;
  offset: number;
}

const PARAGRAPH = `[${BLOCK_TYPE}="paragraph"]`;

function isElement(node: Node | null): node is HTMLElement {
  return node !== null && node.nodeType === 1;
}

function elementOf(node: Node): HTMLElement | null {
  return isElement(node) ? node : node.parentElement;
}

export function paragraphOf(node: Node, root: HTMLElement): HTMLElement | null {
  const paragraph = elementOf(node)?.closest<HTMLElement>(PARAGRAPH) ?? null;
  return paragraph !== null && root.contains(paragraph) ? paragraph : null;
}

/** The leaves of a paragraph in order, without those of paragraphs merged into it. */
export function leavesOf(paragraph: HTMLElement): HTMLElement[] {
  return Array.from(paragraph.querySelectorAll<HTMLElement>(`[${LEAF_START}]`)).filter((leaf) => leaf.closest(PARAGRAPH) === paragraph);
}

function leafStart(leaf: Element): number {
  return Number(leaf.getAttribute(LEAF_START));
}

function leafLength(leaf: Element): number {
  return Number(leaf.getAttribute(LEAF_LENGTH));
}

function isAtom(leaf: Element): boolean {
  return leaf.hasAttribute(LEAF_ATOM);
}

function childIndex(node: Node): number {
  return Array.prototype.indexOf.call(node.parentNode?.childNodes ?? [], node) as number;
}

/** -1 when the point `(node, offset)` is before the start of `target`, 1 when after, 0 when inside. */
function pointVersusNode(node: Node, offset: number, target: Node): number {
  if (node === target || target.contains(node)) return 0;
  const reference = node.childNodes[offset] ?? null;
  if (reference !== null) {
    if (reference === target || reference.contains(target)) return -1;
    return reference.compareDocumentPosition(target) & 4 /* FOLLOWING */ ? -1 : 1;
  }
  // The point is at the end of `node`: everything inside it is before the point.
  if (node.contains(target)) return 1;
  return node.compareDocumentPosition(target) & 4 ? -1 : 1;
}

/** Characters of a leaf's text that are before the point, for a point inside the leaf. */
function unitsBefore(leaf: HTMLElement, node: Node, offset: number): number {
  let count = 0;
  const walker = leaf.ownerDocument.createTreeWalker(leaf, 4 /* SHOW_TEXT */);
  for (let text = walker.nextNode(); text !== null; text = walker.nextNode()) {
    if (text === node) return count + offset;
    if (pointVersusNode(node, offset, text) <= 0) return count;
    count += (text.nodeValue ?? "").length;
  }
  return count;
}

function offsetInParagraph(paragraph: HTMLElement, node: Node, offset: number): number {
  const leaves = leavesOf(paragraph);
  const inside = elementOf(node)?.closest<HTMLElement>(`[${LEAF_START}]`) ?? null;
  if (inside !== null && inside.closest(PARAGRAPH) === paragraph) {
    const start = leafStart(inside);
    const length = leafLength(inside);
    if (isAtom(inside)) return start + (node === inside && offset === 0 ? 0 : length);
    return start + Math.min(length, Math.max(0, unitsBefore(inside, node, offset)));
  }
  for (const leaf of leaves) {
    if (pointVersusNode(node, offset, leaf) < 0) return leafStart(leaf);
  }
  const last = leaves[leaves.length - 1];
  return last === undefined ? 0 : leafStart(last) + leafLength(last);
}

/**
 * The engine position of a DOM boundary point inside `root`, or null when the
 * point is outside it or the document shows no paragraph.
 */
export function positionFromDom(root: HTMLElement, node: Node, offset: number): TextPosition | null {
  if (!root.contains(node)) return null;
  const paragraph = paragraphOf(node, root);
  if (paragraph !== null) {
    // A point in a paragraph merged into this one belongs to that paragraph.
    return { blockId: paragraph.getAttribute(BLOCK_ID) as string, offset: offsetInParagraph(paragraph, node, offset) };
  }
  // Between blocks (a table border, the gap between stories): the nearest paragraph.
  const paragraphs = Array.from(root.querySelectorAll<HTMLElement>(PARAGRAPH));
  const after = paragraphs.find((candidate) => pointVersusNode(node, offset, candidate) < 0);
  if (after !== undefined) {
    const first = leavesOf(after)[0];
    return { blockId: after.getAttribute(BLOCK_ID) as string, offset: first === undefined ? 0 : leafStart(first) };
  }
  const before = paragraphs[paragraphs.length - 1];
  if (before === undefined) return null;
  const leaves = leavesOf(before);
  const last = leaves[leaves.length - 1];
  return { blockId: before.getAttribute(BLOCK_ID) as string, offset: last === undefined ? 0 : leafStart(last) + leafLength(last) };
}

function before(leaf: HTMLElement): DomPoint {
  return { node: leaf.parentNode as Node, offset: childIndex(leaf) };
}

function after(leaf: HTMLElement): DomPoint {
  return { node: leaf.parentNode as Node, offset: childIndex(leaf) + 1 };
}

function insideText(leaf: HTMLElement, units: number): DomPoint | null {
  const text = leaf.firstChild;
  if (text === null || text.nodeType !== 3) return null;
  return { node: text, offset: Math.min(units, (text.nodeValue ?? "").length) };
}

/**
 * The DOM boundary point of an offset in a rendered paragraph. An offset in
 * hidden text goes to the end of the shown text before it.
 */
export function domFromOffset(paragraph: HTMLElement, offset: number): DomPoint {
  const leaves = leavesOf(paragraph);
  if (leaves.length === 0) {
    const filler = Array.from(paragraph.childNodes).find((child) => isElement(child) && child.hasAttribute(FILLER));
    return { node: paragraph, offset: filler === undefined ? paragraph.childNodes.length : childIndex(filler) };
  }
  let ending: HTMLElement | null = null;
  let starting: HTMLElement | null = null;
  let lastBefore: HTMLElement | null = null;
  for (const leaf of leaves) {
    const start = leafStart(leaf);
    const end = start + leafLength(leaf);
    if (start < offset && offset < end && !isAtom(leaf)) return insideText(leaf, offset - start) ?? before(leaf);
    if (end === offset) ending = leaf;
    if (start === offset && starting === null) starting = leaf;
    if (end <= offset) lastBefore = leaf;
  }
  // Stay with the text before the caret, so typing continues the run it follows.
  if (ending !== null && !isAtom(ending)) return insideText(ending, leafLength(ending)) ?? after(ending);
  if (starting !== null && !isAtom(starting)) return insideText(starting, 0) ?? before(starting);
  if (ending !== null) return after(ending);
  if (starting !== null) return before(starting);
  if (lastBefore !== null) return isAtom(lastBefore) ? after(lastBefore) : (insideText(lastBefore, leafLength(lastBefore)) ?? after(lastBefore));
  return before(leaves[0] as HTMLElement);
}

/** The visible offsets a caret can take in a rendered paragraph: first and last. */
export function shownBounds(paragraph: HTMLElement): { start: number; end: number } {
  const leaves = leavesOf(paragraph);
  const first = leaves[0];
  const last = leaves[leaves.length - 1];
  if (first === undefined || last === undefined) return { start: 0, end: 0 };
  return { start: leafStart(first), end: leafStart(last) + leafLength(last) };
}
