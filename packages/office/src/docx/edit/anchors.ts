/**
 * Anchors that outlive the content around them.
 *
 * When text, a paragraph or a table row leaves the document, three kinds of
 * zero-width markup inside it must stay, or the file is no longer valid for
 * other software:
 *
 * - range markers (bookmarks, comment ranges, move ranges, permissions): a
 *   start without its end, or the reverse, is refused by strict readers;
 * - the `w:commentReference` run of a comment: without it the comment is an
 *   orphan that word processors do not show;
 * - the characters of a complex field (`begin`, `separate`, `end` and the
 *   instruction between them) whose other half lies outside what goes: a
 *   field that begins and never ends takes the rest of the story with it.
 *
 * `collectAnchors` finds them in document order and `rescueAnchors` moves
 * them to the nearest paragraph that stays. A field that lies wholly inside
 * the removed content goes with it.
 */

import type { XmlElement } from "../../api/xml.js";
import { appendChild, createElement, insertBefore } from "../../xml/index.js";
import { attr, firstChild } from "../internal.js";
import { copyRunProps, setRunDeleted } from "./text.js";
import { elementParent, isRangeMarker } from "./xml-util.js";

/** Bound on the elements one removal looks at. */
const MAX_ELEMENTS = 2_000_000;

const FIELD_TEXT: ReadonlySet<string> = new Set(["w:instrText", "w:delInstrText"]);
/** Containers whose first paragraph is where the content of a story starts. */
const STORY_ROOTS: ReadonlySet<string> = new Set(["w:body", "w:hdr", "w:ftr", "w:footnote", "w:endnote", "w:comment"]);

export interface AnchorOptions {
  /**
   * Which field characters stay. Default: those of fields that are not
   * wholly inside the removed element. A set names them, when several
   * elements go together and a field may lie across them (see
   * {@link fieldNodesToKeep}). False leaves every field character where it
   * is: the caller removes a whole field on purpose.
   */
  readonly fields?: boolean | ReadonlySet<XmlElement>;
}

/** The field characters and instruction texts below `root`, in document order, with the run of each. */
function fieldNodesIn(root: XmlElement): Array<{ node: XmlElement; run: XmlElement }> {
  const found: Array<{ node: XmlElement; run: XmlElement }> = [];
  const stack: XmlElement[] = [root];
  for (let guard = 0; stack.length > 0 && guard < MAX_ELEMENTS; guard++) {
    const element = stack.pop() as XmlElement;
    if (element.name === "w:r") {
      for (const node of element.children) {
        if (node.kind === "element" && (node.name === "w:fldChar" || FIELD_TEXT.has(node.name))) found.push({ node, run: element });
      }
      continue;
    }
    for (let at = element.children.length - 1; at >= 0; at--) {
      const node = element.children[at];
      if (node !== undefined && node.kind === "element") stack.push(node);
    }
  }
  return found;
}

/** Child indexes from the top of the tree down to `element`. */
function pathOf(element: XmlElement, indexes: Map<XmlElement, Map<unknown, number>>): number[] {
  const path: number[] = [];
  let scope: XmlElement = element;
  for (let depth = 0; depth < 1024; depth++) {
    const parent = elementParent(scope);
    if (parent === null) break;
    let byNode = indexes.get(parent);
    if (byNode === undefined) {
      byNode = new Map(parent.children.map((node, at) => [node, at] as const));
      indexes.set(parent, byNode);
    }
    path.push(byNode.get(scope) ?? 0);
    scope = parent;
  }
  return path.reverse();
}

function comparePaths(a: readonly number[], b: readonly number[]): number {
  for (let at = 0; at < a.length && at < b.length; at++) {
    const difference = (a[at] as number) - (b[at] as number);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

/**
 * The field characters and instruction texts that must stay when every one
 * of `roots` leaves the document together: those of fields that begin or
 * end outside all of them. A field that lies wholly inside the removed
 * content, even across several of its elements, goes with it.
 */
export function fieldNodesToKeep(roots: readonly XmlElement[]): Set<XmlElement> {
  const keep = new Set<XmlElement>();
  const withFields: Array<{ root: XmlElement; nodes: XmlElement[] }> = [];
  const all = new Set(roots);
  for (const root of all) {
    // What lies in a root inside another root is counted with the outer one.
    let nested = false;
    for (let scope = elementParent(root), depth = 0; scope !== null && depth < 64; scope = elementParent(scope), depth++) {
      if (all.has(scope)) nested = true;
    }
    if (nested) continue;
    const nodes = fieldNodesIn(root).map((entry) => entry.node);
    if (nodes.length > 0) withFields.push({ root, nodes });
  }
  if (withFields.length === 0) return keep;
  if (withFields.length > 1) {
    // Local to this call: one entry per ancestor of a removed element that holds field characters.
    const indexes = new Map<XmlElement, Map<unknown, number>>();
    const paths = new Map(withFields.map((entry) => [entry.root, pathOf(entry.root, indexes)] as const));
    withFields.sort((a, b) => comparePaths(paths.get(a.root) ?? [], paths.get(b.root) ?? []));
  }
  /** Fields opened inside the removed content and not yet closed. */
  const open: XmlElement[][] = [];
  for (const { nodes } of withFields) {
    for (const node of nodes) {
      const type = node.name === "w:fldChar" ? attr(node, "w:fldCharType") : "code";
      const top = open[open.length - 1];
      if (type === "begin") open.push([node]);
      else if (type === "end") {
        // A field that began inside goes as a whole; an end whose begin is outside stays.
        if (top !== undefined) open.pop();
        else keep.add(node);
      } else if (top !== undefined) top.push(node);
      else keep.add(node);
    }
  }
  // Fields that begin inside and end outside keep their begin, instruction and separator.
  for (const frame of open) for (const node of frame) keep.add(node);
  return keep;
}

/**
 * The anchors inside `root` that must stay when `root` goes, in document
 * order, each ready to be placed among the runs of a paragraph: a range
 * marker as it is, and a run that holds the comment references and field
 * characters to keep (the run itself when it holds nothing else, else a new
 * run with a copy of its properties).
 */
export function collectAnchors(root: XmlElement, options: AnchorOptions = {}): XmlElement[] {
  const fields = options.fields ?? true;
  const fieldKeep: ReadonlySet<XmlElement> = fields === false ? new Set() : fields === true ? fieldNodesToKeep([root]) : fields;
  /** Children of runs to keep, by run. Local to this call: at most one entry per run of the removed content. */
  const kept = new Map<XmlElement, XmlElement[]>();
  /** Range markers, and runs with something to keep, in document order. */
  const order: XmlElement[] = [];
  const stack: XmlElement[] = [root];
  for (let guard = 0; stack.length > 0 && guard < MAX_ELEMENTS; guard++) {
    const element = stack.pop() as XmlElement;
    if (element !== root && isRangeMarker(element.name)) {
      order.push(element);
      continue;
    }
    if (element.name === "w:r") {
      const nodes: XmlElement[] = [];
      for (const node of element.children) {
        if (node.kind === "element" && (node.name === "w:commentReference" || fieldKeep.has(node))) nodes.push(node);
      }
      if (nodes.length > 0) {
        kept.set(element, nodes);
        order.push(element);
      }
      continue;
    }
    for (let at = element.children.length - 1; at >= 0; at--) {
      const node = element.children[at];
      if (node !== undefined && node.kind === "element") stack.push(node);
    }
  }

  const anchors: XmlElement[] = [];
  for (const entry of order) {
    const nodes = kept.get(entry);
    if (nodes === undefined) {
      anchors.push(entry);
      continue;
    }
    const others = entry.children.some((node) => node.kind === "element" && node.name !== "w:rPr" && !nodes.includes(node));
    if (!others) {
      anchors.push(entry);
      continue;
    }
    const run = createElement("w:r");
    // A copy without tracked-change records: their ids must stay unique.
    const properties = copyRunProps(firstChild(entry, "w:rPr"));
    if (properties !== null) appendChild(run, properties);
    for (const node of nodes) appendChild(run, node);
    anchors.push(run);
  }
  return anchors;
}

function inDeletion(element: XmlElement | null): boolean {
  for (let scope = element, depth = 0; scope !== null && depth < 64; scope = elementParent(scope), depth++) {
    if (scope.name === "w:del") return true;
    if (scope.name === "w:p") return false;
  }
  return false;
}

/** Moves the anchors of `root` in front of `reference`, which stays in the document. Returns true when there were any. */
export function hoistAnchorsBefore(root: XmlElement, reference: XmlElement, options: AnchorOptions = {}): boolean {
  const anchors = collectAnchors(root, options);
  const deleted = inDeletion(elementParent(reference));
  for (const anchor of anchors) {
    insertBefore(reference, anchor);
    setRunDeleted(anchor, deleted);
  }
  return anchors.length > 0;
}

function firstParagraphIn(element: XmlElement): XmlElement | null {
  const stack: XmlElement[] = [element];
  for (let guard = 0; stack.length > 0 && guard < MAX_ELEMENTS; guard++) {
    const current = stack.pop() as XmlElement;
    if (current.name === "w:p") return current;
    if (current.name === "w:r") continue;
    for (let at = current.children.length - 1; at >= 0; at--) {
      const node = current.children[at];
      if (node !== undefined && node.kind === "element") stack.push(node);
    }
  }
  return null;
}

function lastParagraphIn(element: XmlElement): XmlElement | null {
  const stack: XmlElement[] = [element];
  for (let guard = 0; stack.length > 0 && guard < MAX_ELEMENTS; guard++) {
    const current = stack.pop() as XmlElement;
    if (current.name === "w:p") return current;
    if (current.name === "w:r") continue;
    for (const node of current.children) if (node.kind === "element") stack.push(node);
  }
  return null;
}

/** The paragraph after `element` in its story (true) or before it (false), outside `element`. */
function neighbourParagraph(element: XmlElement, forward: boolean): XmlElement | null {
  let scope: XmlElement | null = element;
  for (let depth = 0; scope !== null && depth < 64; depth++) {
    if (STORY_ROOTS.has(scope.name)) return null;
    const parent: XmlElement | null = elementParent(scope);
    if (parent === null) return null;
    const siblings = parent.children;
    const at = siblings.indexOf(scope);
    for (let next = forward ? at + 1 : at - 1; next >= 0 && next < siblings.length; next += forward ? 1 : -1) {
      const node = siblings[next];
      if (node === undefined || node.kind !== "element") continue;
      const found = forward ? firstParagraphIn(node) : lastParagraphIn(node);
      if (found !== null) return found;
    }
    scope = parent;
  }
  return null;
}

/**
 * Moves the anchors of a block that is about to be removed (a paragraph, a
 * table, a table row) into the nearest paragraph that stays: the start of
 * the one that follows, else the end of the one before. Returns that
 * paragraph, or null when nothing had to move.
 */
export function rescueAnchors(root: XmlElement): XmlElement | null {
  const anchors = collectAnchors(root);
  if (anchors.length === 0) return null;
  const following = neighbourParagraph(root, true);
  if (following !== null) {
    let reference: XmlElement["children"][number] | null = null;
    for (const node of following.children) {
      if (node.kind === "element" && node.name === "w:pPr") continue;
      reference = node;
      break;
    }
    for (const anchor of anchors) {
      if (reference === null) appendChild(following, anchor);
      else insertBefore(reference, anchor);
      setRunDeleted(anchor, false);
    }
    return following;
  }
  const preceding = neighbourParagraph(root, false);
  if (preceding === null) return null;
  for (const anchor of anchors) {
    appendChild(preceding, anchor);
    setRunDeleted(anchor, false);
  }
  return preceding;
}
