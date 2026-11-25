/** Small tree helpers shared by the editing and revision engines. */

import type { XmlChildNode, XmlElement } from "../../api/xml.js";
import { appendChild, createElement, insertBefore, prependChild, remove, replaceNode, setAttr } from "../../xml/index.js";
import type { DocxIndex, InsertionPoint } from "../internal.js";
import { REVISION_CONTAINERS, attr, firstChild } from "../internal.js";

export function elementParent(node: XmlChildNode): XmlElement | null {
  const parent = node.parent;
  return parent !== null && parent.kind === "element" ? parent : null;
}

/** The sibling element before `node`, looking past whitespace and comments. */
export function previousElement(node: XmlChildNode): XmlElement | null {
  const parent = elementParent(node);
  if (parent === null) return null;
  const siblings = parent.children;
  for (let at = siblings.indexOf(node) - 1; at >= 0; at--) {
    const sibling = siblings[at] as XmlChildNode;
    if (sibling.kind === "element") return sibling;
  }
  return null;
}

export function nextElement(node: XmlChildNode): XmlElement | null {
  const parent = elementParent(node);
  if (parent === null) return null;
  const siblings = parent.children;
  for (let at = siblings.indexOf(node) + 1; at < siblings.length; at++) {
    const sibling = siblings[at] as XmlChildNode;
    if (sibling.kind === "element") return sibling;
  }
  return null;
}

export function lastElement(parent: XmlElement): XmlElement | null {
  const nodes = parent.children;
  for (let at = nodes.length - 1; at >= 0; at--) {
    const node = nodes[at] as XmlChildNode;
    if (node.kind === "element") return node;
  }
  return null;
}

/** Puts `node` at an insertion point. */
export function insertAt(point: InsertionPoint, node: XmlChildNode): void {
  if (point.before === null) appendChild(point.parent, node);
  else insertBefore(point.before, node);
}

/** The element before an insertion point, or null at the start of its parent. */
export function elementBefore(point: InsertionPoint): XmlElement | null {
  return point.before === null ? lastElement(point.parent) : previousElement(point.before);
}

/** The element at an insertion point (the one new nodes go in front of), or null. */
export function elementAfter(point: InsertionPoint): XmlElement | null {
  if (point.before === null) return null;
  return point.before.kind === "element" ? point.before : nextElement(point.before);
}

/** Replaces an element with one of another name that has the same attributes and children. */
export function renameElement(element: XmlElement, name: string): XmlElement {
  if (element.name === name) return element;
  const renamed = createElement(
    name,
    element.attrs.map((entry) => [entry.name, entry.value] as const),
  );
  for (const node of [...element.children]) appendChild(renamed, node);
  replaceNode(element, renamed);
  return renamed;
}

function rank(order: readonly string[], name: string): number {
  const known = order.indexOf(name);
  return known === -1 ? order.indexOf("*") : known;
}

/** Inserts `node` among the children of `parent` at the place the schema order gives it. */
export function insertOrdered(parent: XmlElement, node: XmlElement, order: readonly string[]): void {
  const own = rank(order, node.name);
  for (const sibling of parent.children) {
    if (sibling.kind === "element" && rank(order, sibling.name) > own) {
      insertBefore(sibling, node);
      return;
    }
  }
  appendChild(parent, node);
}

/** The named child, created at its schema position when it is missing. */
export function ensureChild(parent: XmlElement, name: string, order: readonly string[]): XmlElement {
  const existing = firstChild(parent, name);
  if (existing !== null) return existing;
  const created = createElement(name);
  insertOrdered(parent, created, order);
  return created;
}

/** The named child, created as the first child when it is missing (`w:pPr`, `w:rPr`, `w:trPr` after `w:tblPrEx`). */
export function ensureFirst(parent: XmlElement, name: string, after: string | null = null): XmlElement {
  const existing = firstChild(parent, name);
  if (existing !== null) return existing;
  const created = createElement(name);
  const anchor = after === null ? null : firstChild(parent, after);
  if (anchor === null) prependChild(parent, created);
  else {
    const following = nextElement(anchor);
    if (following === null) appendChild(parent, created);
    else insertBefore(following, created);
  }
  return created;
}

/** Removes every child with one of the names. Returns true when something was removed. */
export function removeChildren(parent: XmlElement, names: ReadonlySet<string> | string): boolean {
  let removed = false;
  for (const node of [...parent.children]) {
    if (node.kind !== "element") continue;
    if (typeof names === "string" ? node.name === names : names.has(node.name)) {
      remove(node);
      removed = true;
    }
  }
  return removed;
}

export function hasElementChildren(element: XmlElement): boolean {
  for (const node of element.children) if (node.kind === "element") return true;
  return false;
}

/** True while `element` is part of the tree of a document part. */
export function isAttached(index: DocxIndex, element: XmlElement): boolean {
  return index.store.slotOf(element) !== null;
}

/** The nearest `w:ins`, `w:del`, `w:moveFrom` or `w:moveTo` around inline content, starting at `element` itself. */
export function nearestRevision(element: XmlElement): XmlElement | null {
  let scope: XmlElement | null = element;
  for (let depth = 0; scope !== null && depth < 64; depth++) {
    if (scope.name === "w:p" || scope.name === "w:tc" || scope.name === "w:body") return null;
    if (REVISION_CONTAINERS.has(scope.name)) return scope;
    scope = elementParent(scope);
  }
  return null;
}

/** Gives every tracked-change record in a copied subtree a fresh `w:id`. */
export function renumberRevisions(index: DocxIndex, copy: XmlElement): void {
  const stack: XmlElement[] = [copy];
  while (stack.length > 0) {
    const element = stack.pop() as XmlElement;
    if (
      attr(element, "w:id") !== null &&
      (REVISION_CONTAINERS.has(element.name) || element.name.endsWith("Change") || element.name.startsWith("w:cell"))
    ) {
      setAttr(element, "w:id", index.allocateAnnotationId());
    }
    for (const node of element.children) if (node.kind === "element") stack.push(node);
  }
}

/** Zero-width range markers that must survive when the content around them goes. */
export function isRangeMarker(name: string): boolean {
  return (
    name === "w:bookmarkStart" ||
    name === "w:bookmarkEnd" ||
    name === "w:commentRangeStart" ||
    name === "w:commentRangeEnd" ||
    name === "w:permStart" ||
    name === "w:permEnd" ||
    name.endsWith("RangeStart") ||
    name.endsWith("RangeEnd")
  );
}

/** Inline wrappers that are removed once nothing but their properties is left in them. */
const DISPOSABLE_WRAPPERS: ReadonlySet<string> = new Set([
  "w:ins",
  "w:del",
  "w:moveFrom",
  "w:moveTo",
  "w:hyperlink",
  "w:smartTag",
  "w:fldSimple",
  "w:dir",
  "w:bdo",
]);

/**
 * Removes `start` and then every inline wrapper above it that is left
 * without content. Range markers inside a wrapper that goes are moved out,
 * so bookmarks and comment ranges keep both ends.
 */
export function removeEmptyWrappers(start: XmlElement | null): void {
  let scope = start;
  for (let depth = 0; scope !== null && depth < 64; depth++) {
    if (!DISPOSABLE_WRAPPERS.has(scope.name)) return;
    const markers: XmlElement[] = [];
    for (const node of scope.children) {
      if (node.kind !== "element") continue;
      if (isRangeMarker(node.name)) markers.push(node);
      else if (!node.name.endsWith("Pr")) return;
    }
    const parent = elementParent(scope);
    if (parent === null) return;
    for (const marker of markers) insertBefore(scope, marker);
    remove(scope);
    scope = parent;
  }
}
