/** What one `applyOps` call carries from primitive to primitive. */

import type { BlockId, TextPosition, TextRange } from "../../api/docx-model.js";
import type { XmlElement } from "../../api/xml.js";
import { OfficeError } from "../../errors.js";
import type { BlockRecord, DocxIndex, ResolvedPosition } from "../internal.js";
import { attr, closest, resolvePosition } from "../internal.js";
import { PositionTracker } from "./tracker.js";

export interface EditContext {
  readonly index: DocxIndex;
  /** True records edits as tracked revisions. */
  readonly track: boolean;
  readonly author: string;
  readonly date: string;
  readonly initials: string;
  readonly tracker: PositionTracker;
  /** `w:p` and `w:tbl` elements whose view changed during the call. */
  readonly touched: Set<XmlElement>;
  /** Tracked-change elements the current operation created or extended. */
  revisionElements: XmlElement[];
  /** Block elements the current operation created. */
  createdElements: XmlElement[];
}

export function createContext(
  index: DocxIndex,
  options: { track: boolean; author: string; date: string; initials: string },
): EditContext {
  return {
    index,
    track: options.track,
    author: options.author,
    date: options.date,
    initials: options.initials,
    tracker: new PositionTracker(),
    touched: new Set(),
    revisionElements: [],
    createdElements: [],
  };
}

/** Attributes of a new tracked-change element. */
export function revisionAttrs(context: EditContext): Array<readonly [string, string]> {
  return [
    ["w:id", context.index.allocateAnnotationId()],
    ["w:author", context.author],
    ["w:date", context.date],
  ];
}

export function isOwn(context: EditContext, revision: XmlElement): boolean {
  return attr(revision, "w:author") === context.author;
}

/** Notes that the view of the block that holds `element` changed, and tells the index. */
export function touch(context: EditContext, element: XmlElement): void {
  const block = element.name === "w:tbl" ? element : (closest(element, "w:p") ?? closest(element, "w:tbl"));
  if (block !== null) context.touched.add(block);
  context.index.markDirty(element);
}

export function noteRevision(context: EditContext, element: XmlElement): void {
  if (!context.revisionElements.includes(element)) context.revisionElements.push(element);
}

export function blockIdOf(context: EditContext, paragraph: XmlElement): BlockId {
  const record = context.index.blockOf(paragraph);
  if (record === null) throw new OfficeError("invalid_operation", "the paragraph is not part of a story");
  return record.id;
}

export interface ResolvedRange {
  readonly start: ResolvedPosition;
  readonly end: ResolvedPosition;
  /** True when both ends are in one paragraph. */
  readonly single: boolean;
  readonly empty: boolean;
}

function requirePosition(value: unknown, what: string): asserts value is TextPosition {
  const position = value as Partial<TextPosition> | null;
  if (
    position === null ||
    typeof position !== "object" ||
    typeof position.blockId !== "string" ||
    typeof position.offset !== "number"
  ) {
    throw new OfficeError("invalid_argument", `${what} must be a text position`);
  }
}

/** Validates a position of an operation: shape first (`invalid_argument`), then the document (`stale_reference`). */
export function resolveAt(context: EditContext, position: unknown, what = "at"): ResolvedPosition {
  requirePosition(position, what);
  return resolvePosition(context.index, position);
}

/**
 * Validates a range: both ends must exist, be in order, and be in the same
 * paragraph or in sibling paragraphs.
 */
export function resolveRange(context: EditContext, range: unknown): ResolvedRange {
  const value = range as Partial<TextRange> | null;
  if (value === null || typeof value !== "object") throw new OfficeError("invalid_argument", "range must be a text range");
  const start = resolveAt(context, value.start, "range.start");
  const end = resolveAt(context, value.end, "range.end");
  if (start.record.id === end.record.id) {
    if (start.offset > end.offset) throw new OfficeError("invalid_argument", "the range starts after its end");
    return { start, end, single: true, empty: start.offset === end.offset };
  }
  const a: BlockRecord = start.record;
  const b: BlockRecord = end.record;
  if (a.container !== b.container) {
    throw new OfficeError("invalid_operation", "the ends of the range are not sibling paragraphs", {
      details: { start: a.id, end: b.id },
    });
  }
  if (a.indexInContainer > b.indexInContainer) {
    throw new OfficeError("invalid_argument", "the range starts after its end");
  }
  return { start, end, single: false, empty: false };
}
