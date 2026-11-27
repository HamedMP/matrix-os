/** Inserting text at a position, directly or as a tracked insertion. */

import type { RunFormat, TextPosition } from "../../api/docx-model.js";
import type { XmlElement } from "../../api/xml.js";
import { appendChild, createElement, prependChild } from "../../xml/index.js";
import type { InsertionPoint, ResolvedPosition, RunBoundary } from "../internal.js";
import { closest, firstChild, splitContainerAt, splitRunAt } from "../internal.js";
import { type EditContext, isOwn, noteRevision, revisionAttrs, touch } from "./context.js";
import { applyRunFormat, runResolverFor } from "./run-format.js";
import { copyRunProps, makeRun, markRunProps } from "./text.js";
import { elementAfter, elementBefore, insertAt, nearestRevision } from "./xml-util.js";

export interface InsertTextOptions {
  /** Direct formatting on top of the inherited formatting. */
  readonly format?: Partial<RunFormat>;
  /**
   * Run properties to start from instead of those of the run before the
   * position: a detached `w:rPr`, or null for none.
   */
  readonly baseProps?: XmlElement | null;
}

/** Where content at the very start of a paragraph goes: in front of everything but the properties. */
function paragraphStart(paragraph: XmlElement): InsertionPoint {
  for (const node of paragraph.children) {
    if (node.kind === "element" && node.name === "w:pPr") continue;
    return { parent: paragraph, before: node };
  }
  return { parent: paragraph, before: null };
}

/** The run properties typed text takes over at a boundary. */
function inheritedProps(paragraph: XmlElement, boundary: RunBoundary, point: InsertionPoint): XmlElement | null {
  const source = boundary.before ?? boundary.after;
  if (source === null) return markRunProps(paragraph);
  if (source.name !== "w:r") return null;
  // Text that lands outside the link its neighbour is in keeps the look of that text but not the link style.
  const dropStyle = closest(source, "w:hyperlink") !== closest(point.parent, "w:hyperlink");
  return copyRunProps(firstChild(source, "w:rPr"), dropStyle);
}

/** Lifts a point out of the revision container `revision`, cutting it in two when the point is inside it. */
function liftOutOf(context: EditContext, point: InsertionPoint, revision: XmlElement): InsertionPoint {
  let current = point;
  for (let depth = 0; depth < 64; depth++) {
    const leaving = current.parent === revision;
    current = splitContainerAt(context.index, current);
    if (leaving) break;
  }
  return current;
}

/** Puts nodes in as a tracked insertion: inside an insertion of the same author when there is one, else in a new `w:ins`. */
function placeTracked(context: EditContext, point: InsertionPoint, nodes: readonly XmlElement[]): void {
  let current = point;
  for (let guard = 0; guard < 64; guard++) {
    const revision = nearestRevision(current.parent);
    if (revision === null) break;
    if (revision.name === "w:ins" && isOwn(context, revision)) {
      for (const node of nodes) insertAt(current, node);
      noteRevision(context, revision);
      return;
    }
    current = liftOutOf(context, current, revision);
  }
  const before = elementBefore(current);
  if (before !== null && before.name === "w:ins" && isOwn(context, before)) {
    for (const node of nodes) appendChild(before, node);
    noteRevision(context, before);
    return;
  }
  const after = elementAfter(current);
  if (after !== null && after.name === "w:ins" && isOwn(context, after)) {
    for (let at = nodes.length - 1; at >= 0; at--) prependChild(after, nodes[at] as XmlElement);
    noteRevision(context, after);
    return;
  }
  const insertion = createElement("w:ins", revisionAttrs(context));
  insertAt(current, insertion);
  for (const node of nodes) appendChild(insertion, node);
  noteRevision(context, insertion);
}

/** Puts nodes in as plain content: outside every pending revision around the point. */
function placeDirect(context: EditContext, point: InsertionPoint, nodes: readonly XmlElement[]): void {
  let current = point;
  for (let guard = 0; guard < 64; guard++) {
    const revision = nearestRevision(current.parent);
    if (revision === null) break;
    current = liftOutOf(context, current, revision);
  }
  for (const node of nodes) insertAt(current, node);
}

/**
 * Inserts inline nodes at a resolved position of a paragraph. The nodes
 * together stand for `length` characters of markup text.
 */
export function insertNodesAt(
  context: EditContext,
  resolved: ResolvedPosition,
  build: (boundary: RunBoundary, paragraph: XmlElement, point: InsertionPoint) => XmlElement[],
  length: number,
): TextPosition {
  const paragraph = resolved.record.element;
  const position: TextPosition = { blockId: resolved.record.id, offset: resolved.offset };
  const boundary = splitRunAt(context.index, position);
  const point = boundary.before === null ? paragraphStart(paragraph) : boundary.point;
  const nodes = build(boundary, paragraph, point);
  if (context.track) placeTracked(context, point, nodes);
  else placeDirect(context, point, nodes);
  touch(context, paragraph);
  context.tracker.textInserted(position.blockId, position.offset, length);
  return { blockId: position.blockId, offset: position.offset + length };
}

/** Inserts text at a resolved position. Returns the position after it. */
export function insertTextAt(
  context: EditContext,
  resolved: ResolvedPosition,
  text: string,
  options: InsertTextOptions = {},
): TextPosition {
  if (text.length === 0) return { blockId: resolved.record.id, offset: resolved.offset };
  return insertNodesAt(
    context,
    resolved,
    (boundary, paragraph, point) => {
      let properties = options.baseProps !== undefined ? options.baseProps : inheritedProps(paragraph, boundary, point);
      if (options.format !== undefined) {
        properties ??= createElement("w:rPr");
        applyRunFormat(properties, options.format, runResolverFor(context.index, resolved.record));
      }
      return [makeRun(properties, text)];
    },
    text.length,
  );
}
