/**
 * Review items: the engine's tracked revisions as the review panel shows
 * them, with a label, a short text, a location and a key for document order.
 * Pure functions of the engine handle; nothing here changes the document.
 */

import type {
  BlockId,
  DocxDocument,
  DocxView,
  Revision,
  RevisionId,
  RevisionKind,
  RevisionScope,
  StoryId,
  TextPosition,
  TextRange,
} from "../../../_shared/office-engine/index";
import { authorColorSlot } from "../editor/authors";
import { ModelIndex } from "../editor/model-index";

/** `formatting` for a formatting revision; every other kind changes content. */
export type ReviewCategory = "formatting" | "substantive";

/** A place in the document as plain numbers: the paragraph's position among all shown paragraphs, and the offset in it. */
export interface PositionKey {
  paragraph: number;
  offset: number;
}

export interface ReviewItem {
  id: RevisionId;
  kind: RevisionKind;
  scope: RevisionScope;
  author: string;
  /** ISO 8601 as stored, or null. */
  date: string | null;
  category: ReviewCategory;
  /** The inserted, deleted or moved text, or the text whose formatting changed. Untrusted document text: render as text. */
  text: string;
  /** `text` on one line, shortened. */
  excerpt: string;
  /** `Inserted`, `Deleted`, `Moved from`, `Moved to`, `Formatted`, `Paragraph formatting`, `Row inserted`, `Row deleted`. */
  kindLabel: string;
  /** What a reader needs to judge the change: the excerpt, or the formatting that changed. */
  summary: string;
  /** Where it is, for example `Paragraph 4`, `Table cell`, `Footnote 2 · Paragraph 1`. */
  location: string;
  storyId: StoryId;
  blockIds: BlockId[];
  /** Markup coordinates of the affected text; null for paragraph formatting and table rows. */
  range: TextRange | null;
  /** The first paragraph position the revision touches, for scrolling and the caret. */
  anchor: TextPosition | null;
  pairedWith: RevisionId | null;
  /** Colour slot of the author, as the editor marks use it. */
  colorSlot: number;
  /** Position in document order, 0-based. */
  order: number;
  position: PositionKey;
}

const MAX_EXCERPT = 120;

export function revisionKindLabel(kind: RevisionKind, scope: RevisionScope): string {
  if (scope === "tableRow") return kind === "delete" ? "Row deleted" : "Row inserted";
  switch (kind) {
    case "insert":
      return "Inserted";
    case "delete":
      return "Deleted";
    case "moveFrom":
      return "Moved from";
    case "moveTo":
      return "Moved to";
    case "format":
      return scope === "paragraphFormat" ? "Paragraph formatting" : "Formatted";
  }
}

/** One line, at most `max` characters, paragraph marks shown as ¶. */
export function excerptOf(text: string, max = MAX_EXCERPT): string {
  const line = text.replace(/\n+$/, "").replace(/\n/g, " ¶ ").replace(/\t/g, " ");
  if (line.trim() === "") return "(empty)";
  return line.length > max ? `${line.slice(0, Math.max(0, max - 1))}…` : line;
}

const TOGGLES: Record<string, string> = { bold: "bold", italic: "italic", underline: "underline", strike: "strikethrough" };
const NAMED: Record<string, string> = {
  color: "Colour",
  highlight: "Highlight",
  fontSizePt: "Font size",
  fontFamily: "Font",
  verticalAlign: "Position",
  styleId: "Style",
  headingLevel: "Heading level",
  alignment: "Alignment",
  indentLeftPt: "Left indent",
  indentRightPt: "Right indent",
  firstLineIndentPt: "First-line indent",
  spacingBeforePt: "Space before",
  spacingAfterPt: "Space after",
};

function show(value: unknown): string {
  if (value === null || value === undefined) return "none";
  return String(value);
}

/** A short sentence of what a formatting revision changed, for example `Bold, not italic` or `Alignment: left → center`. */
export function describeFormatChange(change: Revision["formatChange"]): string {
  if (change === null) return "Formatting";
  const parts: string[] = [];
  const keys = new Set([...Object.keys(change.before), ...Object.keys(change.after)]);
  for (const key of keys) {
    const before = (change.before as Record<string, unknown>)[key];
    const after = (change.after as Record<string, unknown>)[key];
    if (before === after) continue;
    const toggle = TOGGLES[key];
    if (toggle !== undefined) parts.push(after === true ? toggle : `not ${toggle}`);
    else parts.push(`${NAMED[key] ?? key}: ${show(before)} → ${show(after)}`);
  }
  if (parts.length === 0) return "Formatting";
  const sentence = parts.join(", ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** A readable date and time, or `No date`. */
export function formatReviewDate(date: string | null, locale?: string): string {
  if (date === null) return "No date";
  const time = Date.parse(date);
  if (Number.isNaN(time)) return "No date";
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(time));
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return new Date(time).toISOString().slice(0, 16).replace("T", " ");
  }
}

/** The document-order key of a position; paragraphs the index does not know sort last. */
export function positionKey(index: ModelIndex, position: TextPosition): PositionKey {
  const entry = index.entry(position.blockId);
  return { paragraph: entry === null ? Number.MAX_SAFE_INTEGER : entry.order, offset: position.offset };
}

export function compareKeys(a: PositionKey, b: PositionKey): number {
  return a.paragraph !== b.paragraph ? a.paragraph - b.paragraph : a.offset - b.offset;
}

/** The first block of a revision that is a paragraph the index knows (a table row lists its table first). */
function firstParagraph(index: ModelIndex, blockIds: readonly BlockId[]): BlockId | null {
  for (const id of blockIds) if (index.entry(id) !== null) return id;
  return null;
}

function storyLabels(view: DocxView): Map<StoryId, string> {
  const labels = new Map<StoryId, string>();
  for (const story of [view.body, ...view.headers, ...view.footers, ...view.footnotes, ...view.endnotes]) labels.set(story.id, story.label);
  return labels;
}

/** Numbers top-level paragraphs per story, 1-based. */
function paragraphNumbers(index: ModelIndex): Map<BlockId, number> {
  const counters = new Map<StoryId, number>();
  const numbers = new Map<BlockId, number>();
  for (const entry of index.paragraphs) {
    if (entry.tableId !== null) continue;
    const next = (counters.get(entry.storyId) ?? 0) + 1;
    counters.set(entry.storyId, next);
    numbers.set(entry.id, next);
  }
  return numbers;
}

interface LocationContext {
  index: ModelIndex;
  numbers: Map<BlockId, number>;
  labels: Map<StoryId, string>;
  bodyId: StoryId;
}

function locationOf(revision: Revision, anchor: BlockId | null, context: LocationContext): string {
  let place: string;
  if (revision.scope === "tableRow") place = "Table row";
  else if (anchor === null) place = "Unknown place";
  else if (context.index.entry(anchor)?.tableId != null) place = "Table cell";
  else place = `Paragraph ${context.numbers.get(anchor) ?? "?"}`;
  if (revision.storyId === context.bodyId) return place;
  return `${context.labels.get(revision.storyId) ?? "Other part"} · ${place}`;
}

/** The pending revisions of a document as review items, in the order the editor shows them. */
export function listReviewItems(doc: DocxDocument, index?: ModelIndex): ReviewItem[] {
  const revisions = doc.listRevisions();
  if (revisions.length === 0) return [];
  const view = doc.getView();
  const model = index ?? ModelIndex.build(view);
  const context: LocationContext = { index: model, numbers: paragraphNumbers(model), labels: storyLabels(view), bodyId: view.body.id };
  const drafts = revisions.map((revision, listed) => {
    const anchorBlock = revision.range?.start.blockId ?? firstParagraph(model, revision.blockIds);
    const anchor: TextPosition | null = revision.range !== null ? revision.range.start : anchorBlock === null ? null : { blockId: anchorBlock, offset: 0 };
    const position = anchor === null ? { paragraph: Number.MAX_SAFE_INTEGER, offset: listed } : positionKey(model, anchor);
    const excerpt = excerptOf(revision.text);
    const item: ReviewItem = {
      id: revision.id,
      kind: revision.kind,
      scope: revision.scope,
      author: revision.author,
      date: revision.date,
      category: revision.kind === "format" ? "formatting" : "substantive",
      text: revision.text,
      excerpt,
      kindLabel: revisionKindLabel(revision.kind, revision.scope),
      summary: revision.kind === "format" ? describeFormatChange(revision.formatChange) : excerpt,
      location: locationOf(revision, anchorBlock, context),
      storyId: revision.storyId,
      blockIds: [...revision.blockIds],
      range: revision.range,
      anchor,
      pairedWith: revision.pairedWith,
      colorSlot: authorColorSlot(revision.author),
      order: 0,
      position,
    };
    return { item, listed };
  });
  drafts.sort((a, b) => compareKeys(a.item.position, b.item.position) || a.listed - b.listed);
  return drafts.map(({ item }, order) => ({ ...item, order }));
}
