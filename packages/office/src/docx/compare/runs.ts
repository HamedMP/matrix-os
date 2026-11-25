/**
 * Run-level surgery on one paragraph element, without a document index, so
 * it works the same on a paragraph of the result, of the revised document
 * and on a detached copy.
 *
 * Offsets are markup offsets of the paragraph (see `scanParagraph`). Splitting
 * runs and wrappers never changes the markup text.
 */

import type { XmlChildNode, XmlElement } from "../../api/xml.js";
import { OfficeError } from "../../errors.js";
import { appendChild, cloneNode, createElement, insertAfter, insertBefore, remove, setAttr, setTextContent } from "../../xml/index.js";
import { type FieldFrame, type InlineAtom, type ParagraphScan, REVISION_CONTAINERS, atomIndexAt, firstChild, scanParagraph } from "../internal.js";
import type { Stamp } from "./types.js";

/** Where new inline nodes go: into `parent`, in front of `before` (at the end when `before` is null). */
export interface Point {
  readonly parent: XmlElement;
  readonly before: XmlChildNode | null;
}

/** A paragraph element with the fields that are open where it starts. */
export interface Para {
  readonly element: XmlElement;
  readonly fieldsIn: readonly FieldFrame[];
}

export function scanOf(para: Para): ParagraphScan {
  return scanParagraph(para.element, para.fieldsIn, -1);
}

export function parentOf(node: XmlChildNode): XmlElement {
  const parent = node.parent;
  if (parent === null || parent.kind !== "element") {
    throw new OfficeError("invalid_operation", "the node is not attached to an element");
  }
  return parent;
}

export function nextSibling(node: XmlChildNode): XmlChildNode | null {
  const siblings = parentOf(node).children;
  return siblings[siblings.indexOf(node) + 1] ?? null;
}

/** The node that represents an atom among the children of its inline container. */
export function topOf(atom: InlineAtom): XmlElement {
  return atom.run ?? atom.node;
}

/** Moves `first` and every sibling after it to the end of `target`. */
function moveTail(first: XmlChildNode, target: XmlElement): void {
  const siblings = parentOf(first).children;
  for (const node of siblings.slice(siblings.indexOf(first))) appendChild(target, node);
}

/** Gives the revision records of a copied subtree fresh ids. */
function renumber(copy: XmlElement, stamp: Stamp): void {
  const stack: XmlElement[] = [copy];
  while (stack.length > 0) {
    const element = stack.pop() as XmlElement;
    const tracked = REVISION_CONTAINERS.has(element.name) || element.name.endsWith("Change");
    if (tracked && element.attrs.some((entry) => entry.name === "w:id")) setAttr(element, "w:id", stamp.nextId());
    for (const node of element.children) if (node.kind === "element") stack.push(node);
  }
}

/** A new element with the name and attributes of `source` and no children. */
function shallowCopy(source: XmlElement): XmlElement {
  return createElement(
    source.name,
    source.attrs.map((entry) => [entry.name, entry.value] as const),
  );
}

function emptyRunLike(run: XmlElement, stamp: Stamp): XmlElement {
  const copy = shallowCopy(run);
  const rPr = firstChild(run, "w:rPr");
  if (rPr !== null) {
    const properties = cloneNode(rPr);
    renumber(properties, stamp);
    appendChild(copy, properties);
  }
  return copy;
}

/** Makes `offset` a boundary between two nodes, splitting a text node and its run when it has to. */
export function splitAt(para: Para, offset: number, stamp: Stamp): void {
  const scan = scanOf(para);
  if (offset <= 0 || offset >= scan.text.length) return;
  const position = atomIndexAt(scan, offset);
  const atom = scan.atoms[position];
  if (atom === undefined || atom.run === null) return;
  const inAtom = offset - atom.start;
  const run = atom.run;
  if (inAtom > 0) {
    const tail = emptyRunLike(run, stamp);
    const rest = createElement(atom.node.name, [["xml:space", "preserve"]], [atom.text.slice(inAtom)]);
    const following = nextSibling(atom.node);
    appendChild(tail, rest);
    if (following !== null) moveTail(following, tail);
    setTextContent(atom.node, atom.text.slice(0, inAtom));
    setAttr(atom.node, "xml:space", "preserve");
    insertAfter(run, tail);
    stamp.touch();
    return;
  }
  const before = scan.atoms[position - 1];
  if (before !== undefined && before.run === run) {
    const tail = emptyRunLike(run, stamp);
    moveTail(atom.node, tail);
    insertAfter(run, tail);
    stamp.touch();
  }
}

/**
 * The nodes that hold the text of `[start, end)`: runs, and objects that sit
 * directly in the paragraph. Runs are split first so that each returned node
 * lies wholly inside the range.
 */
export function nodesInRange(para: Para, start: number, end: number, stamp: Stamp): XmlElement[] {
  if (end <= start) return [];
  splitAt(para, start, stamp);
  splitAt(para, end, stamp);
  const scan = scanOf(para);
  const nodes: XmlElement[] = [];
  for (let position = atomIndexAt(scan, start); position < scan.atoms.length; position++) {
    const atom = scan.atoms[position] as InlineAtom;
    if (atom.start >= end) break;
    const top = topOf(atom);
    if (nodes[nodes.length - 1] !== top) nodes.push(top);
  }
  return nodes;
}

function isProperties(node: XmlChildNode): boolean {
  return node.kind !== "element" || node.name.endsWith("Pr");
}

/** True when nothing but properties precedes `before` in `parent`. */
function atStart(parent: XmlElement, before: XmlChildNode | null): boolean {
  for (const node of parent.children) {
    if (node === before) return true;
    if (!isProperties(node)) return false;
  }
  return before === null;
}

/** Wrappers new text must not silently become part of: a point at their edge moves outside. */
const LEAVE_AT_EDGE: ReadonlySet<string> = new Set(["w:hyperlink", "w:fldSimple", "w:ins", "w:del", "w:moveFrom", "w:moveTo"]);

function endsField(node: XmlChildNode): boolean {
  if (node.kind !== "element" || node.name !== "w:r") return false;
  return node.children.some(
    (child) => child.kind === "element" && child.name === "w:fldChar" && child.attrs.some((entry) => entry.name === "w:fldCharType" && entry.value === "end"),
  );
}

function holdsText(node: XmlChildNode): boolean {
  if (node.kind !== "element") return false;
  if (node.name !== "w:r") return !node.name.endsWith("Start") && !node.name.endsWith("End") && node.name !== "w:proofErr";
  return node.children.some((child) => child.kind === "element" && child.name !== "w:rPr" && child.name !== "w:fldChar");
}

/**
 * The place to insert at `offset`: behind the node that ends there, or in
 * front of the node that starts there at the start of the paragraph. At the
 * edge of a hyperlink, a field or a revision the point is outside it, so new
 * text does not become part of the link or of the field result.
 */
export function pointAt(para: Para, offset: number, stamp: Stamp): Point {
  splitAt(para, offset, stamp);
  const scan = scanOf(para);
  const position = atomIndexAt(scan, offset);
  const after = scan.atoms[position];
  const before = scan.atoms[position - 1];
  const paragraph = para.element;
  if (before !== undefined) {
    const top = topOf(before);
    let point: Point = { parent: parentOf(top), before: nextSibling(top) };
    // Fields whose result ends here: step over the runs that close them.
    const open = new Set(after === undefined ? [] : after.context.fields.map((frame) => frame.key));
    let closing = before.context.fields.filter((frame) => !open.has(frame.key)).length;
    for (let node = point.before; closing > 0 && node !== null && !holdsText(node); node = nextSibling(node)) {
      if (!endsField(node)) continue;
      closing -= 1;
      point = { parent: point.parent, before: nextSibling(node) };
    }
    for (let depth = 0; depth < 64 && point.parent !== paragraph && point.before === null && LEAVE_AT_EDGE.has(point.parent.name); depth++) {
      point = { parent: parentOf(point.parent), before: nextSibling(point.parent) };
    }
    return point;
  }
  if (after !== undefined) {
    const top = topOf(after);
    let point: Point = { parent: parentOf(top), before: top };
    for (
      let depth = 0;
      depth < 64 && point.parent !== paragraph && LEAVE_AT_EDGE.has(point.parent.name) && atStart(point.parent, point.before);
      depth++
    ) {
      point = { parent: parentOf(point.parent), before: point.parent };
    }
    return point;
  }
  return { parent: paragraph, before: null };
}

/** Inserts nodes at a point, in order. */
export function insertAtPoint(point: Point, nodes: readonly XmlChildNode[]): void {
  for (const node of nodes) {
    if (point.before === null) appendChild(point.parent, node);
    else insertBefore(point.before, node);
  }
}

/** Cuts a content control in two around a point inside its content. */
function splitControl(content: XmlElement, before: XmlChildNode, stamp: Stamp): XmlElement {
  const control = parentOf(content);
  const tail = shallowCopy(control);
  for (const node of control.children) {
    if (node.kind !== "element" || node === content) continue;
    const copy = cloneNode(node);
    // A control id is unique in the document; the second half goes without one.
    const id = firstChild(copy, "w:id");
    if (id !== null) remove(id);
    renumber(copy, stamp);
    appendChild(tail, copy);
  }
  const tailContent = shallowCopy(content);
  moveTail(before, tailContent);
  appendChild(tail, tailContent);
  insertAfter(control, tail);
  return tail;
}

/**
 * Lifts a point to a child position of the paragraph itself, cutting every
 * inline wrapper around it in two (unless the point is at the wrapper's
 * edge). The second half of a revision wrapper gets a new id.
 */
export function liftPoint(paragraph: XmlElement, point: Point, stamp: Stamp): Point {
  let current = point;
  if (current.parent !== paragraph) stamp.touch();
  for (let depth = 0; depth < 64 && current.parent !== paragraph; depth++) {
    const container = current.parent;
    const outer = parentOf(container);
    if (current.before === null) {
      current = { parent: outer, before: nextSibling(container) };
    } else if (atStart(container, current.before)) {
      current = { parent: outer, before: container };
    } else if (container.name === "w:sdtContent") {
      const tail = splitControl(container, current.before, stamp);
      current = { parent: parentOf(tail), before: tail };
    } else {
      const tail = shallowCopy(container);
      if (REVISION_CONTAINERS.has(tail.name)) setAttr(tail, "w:id", stamp.nextId());
      moveTail(current.before, tail);
      insertAfter(container, tail);
      current = { parent: outer, before: tail };
    }
  }
  return current;
}

/**
 * Moves the content of `paragraph` in front of `offset` into `head` (a new,
 * detached `w:p` that already has its properties) and puts `head` before the
 * paragraph. `paragraph` keeps its properties and the content from `offset` on.
 */
export function splitParagraphInto(para: Para, offset: number, head: XmlElement, stamp: Stamp): void {
  const paragraph = para.element;
  const point = liftPoint(paragraph, pointAt(para, offset, stamp), stamp);
  for (const node of [...paragraph.children]) {
    if (node === point.before) break;
    if (node.kind === "element" && node.name === "w:pPr") continue;
    appendChild(head, node);
  }
  insertBefore(paragraph, head);
  stamp.touch();
}
