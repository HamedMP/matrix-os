/**
 * From text positions to XML and back: resolving a `TextPosition` to the
 * atom and run it falls in, splitting runs and inline wrappers so that a
 * position becomes a boundary between nodes, and converting offsets between
 * the markup text and the `final` and `original` views.
 */

import type { DocxTextView, TextPosition } from "../../api/docx-model.js";
import type { XmlChildNode, XmlElement } from "../../api/xml.js";
import { OfficeError } from "../../errors.js";
import { appendChild, cloneNode, createElement, insertAfter, setAttr, setTextContent } from "../../xml/index.js";
import type { DocxIndex } from "./doc-index.js";
import { type InlineAtom, type ParagraphScan, atomInView, atomIndexAt } from "./inline.js";
import { REVISION_CONTAINERS, attr, firstChild } from "./names.js";
import type { BlockRecord } from "./structure.js";

export interface ResolvedPosition {
  readonly record: BlockRecord;
  readonly scan: ParagraphScan;
  readonly offset: number;
  /** Index in `scan.atoms` of `atom`; `scan.atoms.length` at the end of the paragraph. */
  readonly atomIndex: number;
  /** The atom that contains the position or starts at it; null at the end of the paragraph. */
  readonly atom: InlineAtom | null;
  /** Characters of `atom` that lie before the position; 0 when the position is at its start. */
  readonly offsetInAtom: number;
  /** The atom that ends at the position or contains it; null at the start of the paragraph. */
  readonly before: InlineAtom | null;
}

/** Where new inline nodes go: into `parent`, in front of `before` (at the end when `before` is null). */
export interface InsertionPoint {
  readonly parent: XmlElement;
  readonly before: XmlChildNode | null;
}

export interface RunBoundary {
  /** The `w:r` (or paragraph-level object) that ends at the position, or null at the start of the paragraph. */
  readonly before: XmlElement | null;
  /** The `w:r` (or paragraph-level object) that starts at the position, or null at the end of the paragraph. */
  readonly after: XmlElement | null;
  /** Directly after `before`, inside whatever wraps it; null at the start of the paragraph. */
  readonly afterPrevious: InsertionPoint | null;
  /** Directly in front of `after`, inside whatever wraps it; at the end of the paragraph, the end of the `w:p`. */
  readonly beforeNext: InsertionPoint;
  /**
   * Where typed text belongs: `afterPrevious`, so it joins what precedes it,
   * unless the position is where a field result or a hyperlink ends (or the
   * paragraph starts); then `beforeNext`, so the text stays outside the field
   * and the link.
   */
  readonly point: InsertionPoint;
}

/** One stretch of a paragraph's text in a view. */
export interface TextSegment {
  readonly atom: InlineAtom;
  /** Offset of the stretch in the markup text. */
  readonly markupStart: number;
  /** Offset of the stretch in the text of the view. */
  readonly viewStart: number;
  readonly text: string;
}

/** Inline wrappers `splitContainerAt` can cut in two. */
const SPLITTABLE: ReadonlySet<string> = new Set([
  "w:ins",
  "w:del",
  "w:moveFrom",
  "w:moveTo",
  "w:hyperlink",
  "w:smartTag",
  "w:dir",
  "w:bdo",
  "w:fldSimple",
]);

/**
 * Resolves a position. Throws `stale_reference` for an unknown block or an
 * offset outside the paragraph text and `invalid_operation` for a block that
 * is not a paragraph.
 */
export function resolvePosition(index: DocxIndex, position: TextPosition): ResolvedPosition {
  const record = index.requireBlock(position?.blockId, "paragraph");
  const scan = index.scan(record.element);
  const offset = position.offset;
  if (!Number.isInteger(offset) || offset < 0 || offset > scan.text.length) {
    throw new OfficeError("stale_reference", "offset is outside the paragraph text", {
      details: { blockId: record.id, offset: Number.isFinite(offset) ? offset : -1, length: scan.text.length },
    });
  }
  const atomIndex = atomIndexAt(scan, offset);
  const atom = scan.atoms[atomIndex] ?? null;
  const offsetInAtom = atom === null ? 0 : offset - atom.start;
  const before = offsetInAtom > 0 ? atom : (scan.atoms[atomIndex - 1] ?? null);
  return { record, scan, offset, atomIndex, atom, offsetInAtom, before };
}

function nextSibling(node: XmlChildNode): XmlChildNode | null {
  const parent = node.parent;
  if (parent === null || parent.kind !== "element") return null;
  const siblings = parent.children;
  const position = siblings.indexOf(node);
  return siblings[position + 1] ?? null;
}

function elementParent(node: XmlChildNode): XmlElement {
  const parent = node.parent;
  if (parent === null || parent.kind !== "element") {
    throw new OfficeError("invalid_operation", "the node is not attached to an element");
  }
  return parent;
}

/** Gives every revision record in a copied subtree a fresh `w:id`, so no id is used twice. */
function renumberRevisions(index: DocxIndex, copy: XmlElement): void {
  const stack: XmlElement[] = [copy];
  while (stack.length > 0) {
    const element = stack.pop() as XmlElement;
    if (attr(element, "w:id") !== null && (REVISION_CONTAINERS.has(element.name) || element.name.endsWith("Change"))) {
      setAttr(element, "w:id", index.allocateAnnotationId());
    }
    for (const node of element.children) if (node.kind === "element") stack.push(node);
  }
}

/** Moves `first` and every sibling after it into `target`, keeping their order. */
function moveTail(first: XmlChildNode, target: XmlElement): void {
  const siblings = elementParent(first).children;
  const tail = siblings.slice(siblings.indexOf(first));
  for (const node of tail) appendChild(target, node);
}

/** A new `w:r` with the attributes and a copy of the run properties of `run`. */
function emptyRunLike(index: DocxIndex, run: XmlElement): XmlElement {
  const copy = createElement(
    run.name,
    run.attrs.map((entry) => [entry.name, entry.value] as const),
  );
  const rPr = firstChild(run, "w:rPr");
  if (rPr !== null) {
    const properties = cloneNode(rPr);
    renumberRevisions(index, properties);
    appendChild(copy, properties);
  }
  return copy;
}

function topOf(atom: InlineAtom): XmlElement {
  return atom.run ?? atom.node;
}

/**
 * Makes the position a boundary between two sibling nodes, splitting a run
 * (and the `w:t` the position falls in) when it has to. Both halves of a
 * split run keep the run properties. The paragraph is marked dirty when the
 * tree changed. Positions and ids of the paragraph stay valid: the markup
 * text does not change.
 */
export function splitRunAt(index: DocxIndex, position: TextPosition): RunBoundary {
  const resolved = resolvePosition(index, position);
  const { atom, before, offsetInAtom, record } = resolved;
  if (atom !== null && offsetInAtom > 0) {
    // Inside the text of one `w:t` or `w:delText`.
    const run = atom.run as XmlElement;
    const text = atom.text;
    const code = text.charCodeAt(offsetInAtom);
    if (code >= 0xdc00 && code <= 0xdfff) {
      throw new OfficeError("invalid_argument", "a position cannot split a surrogate pair", {
        details: { blockId: record.id, offset: resolved.offset },
      });
    }
    const tail = emptyRunLike(index, run);
    const rest = createElement(atom.node.name, [["xml:space", "preserve"]], [text.slice(offsetInAtom)]);
    const following = nextSibling(atom.node);
    appendChild(tail, rest);
    if (following !== null) moveTail(following, tail);
    setTextContent(atom.node, text.slice(0, offsetInAtom));
    setAttr(atom.node, "xml:space", "preserve");
    insertAfter(run, tail);
    index.markDirty(record.element);
    const point: InsertionPoint = { parent: elementParent(run), before: tail };
    return { before: run, after: tail, afterPrevious: point, beforeNext: point, point };
  }
  if (atom !== null && before !== null && atom.run !== null && atom.run === before.run) {
    // Between two nodes of the same run, for example text and a tab.
    const run = atom.run;
    const tail = emptyRunLike(index, run);
    moveTail(atom.node, tail);
    insertAfter(run, tail);
    index.markDirty(record.element);
    const point: InsertionPoint = { parent: elementParent(run), before: tail };
    return { before: run, after: tail, afterPrevious: point, beforeNext: point, point };
  }
  const beforeTop = before === null ? null : topOf(before);
  const afterTop = atom === null ? null : topOf(atom);
  const afterPrevious: InsertionPoint | null =
    beforeTop === null ? null : { parent: elementParent(beforeTop), before: nextSibling(beforeTop) };
  const beforeNext: InsertionPoint =
    afterTop === null ? { parent: record.element, before: null } : { parent: elementParent(afterTop), before: afterTop };
  let leaves = false;
  if (before !== null) {
    const next = atom?.context ?? null;
    const link = before.context.hyperlink;
    leaves =
      (link !== null && link !== (next?.hyperlink ?? null)) ||
      before.context.fields.some((frame) => !(next?.fields ?? []).some((other) => other.key === frame.key));
  }
  return {
    before: beforeTop,
    after: afterTop,
    afterPrevious,
    beforeNext,
    point: afterPrevious === null || leaves ? beforeNext : afterPrevious,
  };
}

/**
 * Lifts an insertion point out of the inline wrapper it is in (`w:ins`,
 * `w:del`, `w:moveFrom`, `w:moveTo`, `w:hyperlink`, `w:fldSimple`,
 * `w:smartTag`): the wrapper is cut in two around the point, unless the point
 * is at its start or end. The second half of a revision wrapper gets a new
 * `w:id`. A point directly in a `w:p` is returned unchanged. A point in the
 * middle of a content control throws `invalid_operation`.
 */
export function splitContainerAt(index: DocxIndex, point: InsertionPoint): InsertionPoint {
  const container = point.parent;
  if (container.name === "w:p") return point;
  const before = point.before;
  const position = before === null ? container.children.length : container.children.indexOf(before);
  const hasEarlier = container.children.some(
    (node, at) => at < position && node.kind === "element" && !node.name.endsWith("Pr") && node.name !== "w:fldData",
  );
  if (container.name === "w:sdtContent" || container.name === "w:customXml") {
    // The control is kept whole: step outside it when the point is at one of its edges.
    if (before !== null && hasEarlier) throw new OfficeError("invalid_operation", "cannot split a content control");
    const wrapper = container.name === "w:sdtContent" ? elementParent(container) : container;
    return { parent: elementParent(wrapper), before: before === null ? nextSibling(wrapper) : wrapper };
  }
  if (!SPLITTABLE.has(container.name)) {
    throw new OfficeError("invalid_operation", "cannot split this inline element", {
      details: { element: container.name },
    });
  }
  const outer = elementParent(container);
  if (before === null) return { parent: outer, before: nextSibling(container) };
  if (!hasEarlier) return { parent: outer, before: container };
  const tail = createElement(
    container.name,
    container.attrs.map((entry) => [entry.name, entry.value] as const),
  );
  if (REVISION_CONTAINERS.has(container.name) && attr(tail, "w:id") !== null) {
    setAttr(tail, "w:id", index.allocateAnnotationId());
  }
  moveTail(before, tail);
  insertAfter(container, tail);
  index.markDirty(outer);
  return { parent: outer, before: tail };
}

/** Applies `splitContainerAt` until the point is a direct child position of its `w:p`. */
export function liftToParagraph(index: DocxIndex, point: InsertionPoint): InsertionPoint {
  let current = point;
  for (let depth = 0; depth < 64 && current.parent.name !== "w:p"; depth++) {
    current = splitContainerAt(index, current);
  }
  return current;
}

/** The text of a paragraph in a view as stretches, each tied to the atom it comes from. Objects are included. */
export function textSegments(scan: ParagraphScan, view: DocxTextView): TextSegment[] {
  const segments: TextSegment[] = [];
  let viewStart = 0;
  for (const atom of scan.atoms) {
    if (!atomInView(atom, view)) continue;
    segments.push({ atom, markupStart: atom.start, viewStart, text: atom.text });
    viewStart += atom.text.length;
  }
  return segments;
}

/**
 * The markup offset of the position that has `offset` characters of the view
 * before it. Where text that is hidden in the view sits at that position,
 * `bias` chooses the side: `before` (default) stays in front of the hidden
 * text, `after` goes behind it. An offset past the end gives the end.
 */
export function viewToMarkupOffset(
  scan: ParagraphScan,
  view: DocxTextView,
  offset: number,
  bias: "before" | "after" = "before",
): number {
  // Every markup offset between `low` and `high` has exactly `offset` view characters before it.
  let low = offset <= 0 ? 0 : -1;
  let high = scan.text.length;
  let seen = 0;
  for (const atom of scan.atoms) {
    if (!atomInView(atom, view)) continue;
    const length = atom.text.length;
    if (low === -1 && offset <= seen + length) low = atom.start + (offset - seen);
    if (offset < seen + length) {
      high = atom.start + Math.max(0, offset - seen);
      break;
    }
    seen += length;
  }
  if (low === -1) low = scan.text.length;
  return bias === "before" ? low : high;
}

/** The number of characters of the view that lie before a markup offset. */
export function markupToViewOffset(scan: ParagraphScan, view: DocxTextView, offset: number): number {
  let count = 0;
  for (const atom of scan.atoms) {
    if (atom.start >= offset) break;
    if (!atomInView(atom, view)) continue;
    count += Math.min(atom.text.length, offset - atom.start);
  }
  return count;
}
