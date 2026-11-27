/**
 * Contract: edit operations on a `.docx` document and their result.
 * Applied through `DocxDocument.applyOps` in `./docx.ts`.
 *
 * Positions use the markup coordinates of `TextPosition` (see `./docx-model.ts`).
 *
 * Validation errors are `OfficeError`:
 * - `stale_reference`: unknown block, comment or story id, or an offset
 *   outside the paragraph text
 * - `invalid_operation`: a block of the wrong type, a range whose ends are
 *   not siblings, a row or cell index out of range, an unknown style id
 * - `invalid_argument`: a malformed operation
 */

import type {
  BlockId,
  CommentId,
  ParagraphStylePatch,
  RevisionId,
  RunFormat,
  StoryId,
  TextPosition,
  TextRange,
} from "./docx-model.js";

/**
 * Text accepted by the insert operations: `\t` becomes a tab and `\n` a line
 * break inside the paragraph. It never creates a paragraph; use
 * `insertParagraphAfter` or `splitParagraph` for that. Other C0 control
 * characters throw `invalid_argument`.
 */
export type InsertableText = string;

/**
 * How `replaceRange` and `setCellText` record a replacement.
 * - `whole`: the old text is deleted and the new text inserted as one unit.
 * - `words`: the old and new text are compared word by word and only the
 *   differences are deleted and inserted, so unchanged words keep their
 *   formatting and are not marked.
 */
export type ReplaceGranularity = "whole" | "words";

/** Inserts text. It takes the formatting of the run before the position unless `format` is given. */
export interface InsertTextOp {
  type: "insertText";
  at: TextPosition;
  text: InsertableText;
  /** Direct formatting for the new text, on top of the inherited formatting. */
  format?: Partial<RunFormat>;
}

/**
 * Deletes a range. A range across paragraphs also deletes the paragraph marks
 * between its ends, which merges the paragraphs (the first one keeps its
 * properties). An empty range does nothing.
 */
export interface DeleteRangeOp {
  type: "deleteRange";
  range: TextRange;
}

/** Deletes the range and inserts the text at its start. */
export interface ReplaceRangeOp {
  type: "replaceRange";
  range: TextRange;
  text: InsertableText;
  format?: Partial<RunFormat>;
  /** Default `whole`. `words` needs a range inside one paragraph. */
  granularity?: ReplaceGranularity;
}

/** Inserts a new paragraph after a paragraph or table. */
export interface InsertParagraphAfterOp {
  type: "insertParagraphAfter";
  blockId: BlockId;
  /** Default: empty. */
  text?: InsertableText;
  /**
   * Paragraph properties of the new paragraph. Default: a copy of the
   * properties of the paragraph it follows (style, numbering, indent), or the
   * default paragraph style after a table.
   */
  style?: Partial<ParagraphStylePatch>;
}

/** Inserts a new paragraph before a paragraph or table. Defaults mirror `insertParagraphAfter`, taken from the block it precedes. */
export interface InsertParagraphBeforeOp {
  type: "insertParagraphBefore";
  blockId: BlockId;
  text?: InsertableText;
  style?: Partial<ParagraphStylePatch>;
}

/**
 * Splits a paragraph in two at a position (the Enter key). The first part
 * keeps the block id; the second is a new block with the same properties.
 */
export interface SplitParagraphOp {
  type: "splitParagraph";
  at: TextPosition;
}

/**
 * Deletes a whole paragraph with its mark. The last paragraph of a table cell
 * or story cannot be removed: its content is deleted and the empty paragraph
 * stays.
 */
export interface DeleteParagraphOp {
  type: "deleteParagraph";
  blockId: BlockId;
}

/** Sets character formatting on a range. Only the given properties change. */
export interface SetRunFormatOp {
  type: "setRunFormat";
  range: TextRange;
  format: Partial<RunFormat>;
}

/** Sets paragraph properties. Only the given properties change. */
export interface SetParagraphStyleOp {
  type: "setParagraphStyle";
  blockId: BlockId;
  style: Partial<ParagraphStylePatch>;
}

/**
 * Inserts a row. The new row copies the cell structure and properties of the
 * row before it (or the row after it at index 0).
 */
export interface InsertTableRowOp {
  type: "insertTableRow";
  tableId: BlockId;
  /** The new row gets this index: 0 inserts first, `rows.length` appends. */
  rowIndex: number;
  /** Text for the cells in order. Missing cells stay empty; extra entries throw `invalid_operation`. */
  cells?: InsertableText[];
}

/** Deletes a row. The last row of a table cannot be deleted (`invalid_operation`). */
export interface DeleteTableRowOp {
  type: "deleteTableRow";
  tableId: BlockId;
  rowIndex: number;
}

/**
 * Replaces the whole content of a cell with text. The first paragraph of the
 * cell keeps its block id and properties; other blocks in the cell are removed.
 */
export interface SetCellTextOp {
  type: "setCellText";
  tableId: BlockId;
  rowIndex: number;
  /** Index into `TableRow.cells`. */
  cellIndex: number;
  text: InsertableText;
  /** Default `words`. */
  granularity?: ReplaceGranularity;
}

/**
 * Starts a comment thread anchored to a non-empty range of the body (table
 * cells included). A range in a header, a footer or a note throws
 * `invalid_operation`: the file format has no place for such a comment.
 * Comments are never tracked changes.
 */
export interface AddCommentOp {
  type: "addComment";
  range: TextRange;
  /** Plain text; `\n` separates paragraphs. */
  text: string;
}

/** Adds a reply to a thread. `commentId` may be any comment of the thread. */
export interface ReplyCommentOp {
  type: "replyComment";
  commentId: CommentId;
  text: string;
}

/** Marks a thread as done, or reopens it. */
export interface ResolveCommentOp {
  type: "resolveComment";
  commentId: CommentId;
  /** Default true. */
  resolved?: boolean;
}

export type DocxOp =
  | InsertTextOp
  | DeleteRangeOp
  | ReplaceRangeOp
  | InsertParagraphAfterOp
  | InsertParagraphBeforeOp
  | SplitParagraphOp
  | DeleteParagraphOp
  | SetRunFormatOp
  | SetParagraphStyleOp
  | InsertTableRowOp
  | DeleteTableRowOp
  | SetCellTextOp
  | AddCommentOp
  | ReplyCommentOp
  | ResolveCommentOp;

export type DocxOpType = DocxOp["type"];

export interface ApplyOptions {
  /**
   * True records the edits as native tracked revisions:
   * - inserted text and paragraphs become insertions
   * - deleted text stays in the document, marked as a deletion; text that is
   *   itself a pending insertion by the same author is removed outright, and
   *   text that is already a pending deletion is left as it is
   * - formatting and paragraph property changes keep the previous properties
   *   as a formatting revision
   * - inserted and deleted table rows are marked on the row
   *
   * False changes the content directly. Existing revisions are kept; text
   * removed from inside one disappears with its share of that revision.
   */
  track: boolean;
  /** Author of the revisions and comments this call creates. */
  author: string;
  /** ISO 8601 timestamp for those revisions and comments. Supplied by the caller: the engine never reads a clock. */
  date: string;
  /** Initials stored on new comments. Default: derived from `author`. */
  initials?: string;
  /**
   * Positions to carry through the edit, for example the caret and the
   * selection ends. They are returned remapped in `ApplyResult.positions`.
   */
  positions?: TextPosition[];
}

/** What one operation did. Same index as the operation in the call. */
export interface DocxOpResult {
  type: DocxOpType;
  /** Revisions this operation created or extended. Empty when not tracked. */
  revisionIds: RevisionId[];
  /** Blocks this operation created, in document order. */
  createdBlockIds: BlockId[];
  /** The comment created by `addComment` or `replyComment`, else null. */
  commentId: CommentId | null;
  /**
   * Where the caret belongs after the operation: after inserted text, at the
   * start of a deleted range, at the start of a new paragraph. Null for
   * operations with no natural caret (comments, formatting).
   */
  caret: TextPosition | null;
}

export interface ApplyResult {
  /** One entry per operation, in order. */
  results: DocxOpResult[];
  /** All revisions created or extended by the call, without duplicates, in document order. */
  revisionIds: RevisionId[];
  createdBlockIds: BlockId[];
  removedBlockIds: BlockId[];
  /** Blocks that still exist and whose view changed, top-level table ids included for changes inside a table. */
  changedBlockIds: BlockId[];
  /** Stories that contain a created, removed or changed block. */
  changedStoryIds: StoryId[];
  /**
   * `ApplyOptions.positions` after the edit, same order and length. A position
   * inside removed text moves to where that text was; a position in a removed
   * block moves to the nearest surviving position, or is null when its story
   * has none.
   */
  positions: Array<TextPosition | null>;
}

export interface ResolveRevisionsResult {
  /** The revisions that were resolved, pairs included. */
  resolvedIds: RevisionId[];
  createdBlockIds: BlockId[];
  removedBlockIds: BlockId[];
  changedBlockIds: BlockId[];
  changedStoryIds: StoryId[];
}
