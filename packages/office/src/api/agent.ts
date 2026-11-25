/**
 * Contract: the bridge between documents and an AI agent.
 * Implemented by `src/agent/index.ts`.
 *
 * Type-only. Each function type is implemented as a value export with the
 * camelCase name given in {@link AgentModule}.
 *
 * Two directions:
 * 1. `describeDocx` / `describeSheet` turn part of a document into bounded
 *    text for a prompt, with the ids the agent must quote back.
 * 2. The agent answers with a JSON {@link AgentEditEnvelope}. `parseAgentEdits`
 *    validates it, `toDocxOps` / `toSheetEdits` check it against the
 *    document and turn it into engine operations.
 *
 * Document text is untrusted. These functions return it as plain text; the
 * caller wraps it as external content before it reaches a model. Nothing here
 * applies an edit by itself except `applySheetEdits`, which records proposed
 * changes, never final ones.
 */

import type { DocxDocument } from "./docx.js";
import type { BlockId, StoryId } from "./docx-model.js";
import type { DocxOp } from "./docx-ops.js";
import type { Workbook } from "./xlsx.js";
import type { CellRange, CellValue, ProposalOptions, SheetId } from "./xlsx-model.js";

export interface DescribeDocxOptions {
  /** Upper bound on the length of the returned text. */
  maxChars: number;
  /** Start at this block (top-level or inside a table) instead of the first one, to continue a truncated description. */
  startBlockId?: BlockId;
  /** Describe another story (a header, footer or note) instead of the body. */
  storyId?: StoryId;
  /** Put the outline of the headings first. Default true; left out when `startBlockId` is given. */
  includeOutline?: boolean;
}

/**
 * A document as text for a prompt.
 *
 * Format of `text`, one item per line:
 * ```
 * # Outline
 * [b12] 1 Definitions
 * [b40]   1.1 Interpretation
 * # Content
 * [b12] (Heading 1) 1 Definitions
 * [b13] 1.1 "Affiliate" means any entity that controls the Company.
 * [b20] (table row 2, cell 1) Price
 * ```
 * - Each paragraph is one line that starts with its block id in square
 *   brackets, then the style name in parentheses when it is a heading, then
 *   the numbering label, then the text. Paragraphs in table cells carry a
 *   `(table row R, cell C)` marker, counted from 1.
 * - The text is the `final` view: pending insertions are included and
 *   pending deletions are not. Line breaks inside a paragraph are written as
 *   a space, inline objects are left out.
 * - A paragraph that does not fit is not cut: the description stops before
 *   it, `truncated` is true and `nextBlockId` names it. The one exception is
 *   a paragraph longer than the whole budget: as the first paragraph of a
 *   description it is cut and ends in `…`, so that a continuation always
 *   moves forward.
 * - The outline lists the headings of the body and takes at most 40% of
 *   `maxChars`; headings that do not fit are counted in a last line
 *   `… N more headings`.
 * - A paragraph that every pending revision removes (deleted or moved away
 *   in full) is left out. An empty paragraph is a line with only its id.
 *
 * Throws `invalid_argument` for a `maxChars` that is not a whole number from
 * 1 to 4 000 000, and `stale_reference` for an unknown `startBlockId` or
 * `storyId`.
 */
export interface DocxDescription {
  text: string;
  truncated: boolean;
  /** The first block that was not described, or null when everything fitted. */
  nextBlockId: BlockId | null;
  /** The blocks described, in order. */
  blockIds: BlockId[];
}

export type DescribeDocx = (document: DocxDocument, options: DescribeDocxOptions) => DocxDescription;

export interface DescribeSheetOptions {
  /** Upper bound on the length of the returned text. */
  maxChars: number;
}

/**
 * Part of a sheet as text for a prompt.
 *
 * Format of `text`: a header line `Sheet "<name>" <range>`, then one line per
 * non-empty cell in row order:
 * ```
 * A1: Revenue
 * B1: 1200
 * B3: =SUM(B1:B2) => 1500
 * ```
 * A literal is written as its display text; a formula as the formula, ` => `
 * and its display text. Line breaks inside a cell are written as a space.
 * When the cells do not fit, the description stops at a row boundary and
 * `truncated` is true; `range` is then the part that was described. When not
 * even the first row fits, the cells of that row that do fit are described
 * and `range` ends at the last of them; a single cell longer than the budget
 * is cut and ends in `…`.
 *
 * A given range is cut down to the used part of the sheet. For an empty sheet,
 * or a range outside the used part, `text` is the header alone.
 * Throws `not_found` for an unknown sheet and `invalid_argument` for a bad
 * `maxChars` (a whole number from 1 to 4 000 000) or range.
 */
export interface SheetDescription {
  text: string;
  truncated: boolean;
  /** The rectangle actually described. */
  range: CellRange;
}

/** `range` null means the used range of the sheet. */
export type DescribeSheet = (
  workbook: Workbook,
  sheet: SheetId,
  range: CellRange | null,
  options: DescribeSheetOptions,
) => SheetDescription;

/**
 * Replace text inside one paragraph. `find` is quoted exactly from the
 * description and must occur in the paragraph's `final` text.
 */
export interface AgentReplaceTextEdit {
  op: "replaceText";
  blockId: BlockId;
  /** The exact existing text to replace; not empty. */
  find: string;
  /** The new text; empty deletes `find`. */
  replace: string;
  /** Which match to use when `find` occurs more than once, from 1. Without it, more than one match is rejected as `ambiguous`. */
  occurrence?: number;
}

/** Insert one new paragraph after (default) or before a paragraph or table. */
export interface AgentInsertParagraphEdit {
  op: "insertParagraph";
  blockId: BlockId;
  position?: "after" | "before";
  text: string;
  /**
   * 1 to 9 makes the paragraph a heading. Without it the paragraph copies
   * its neighbour, except next to a heading, where it gets the default
   * paragraph style.
   */
  headingLevel?: number;
}

/** Delete a whole paragraph. `startsWith` proves which paragraph was meant. */
export interface AgentDeleteParagraphEdit {
  op: "deleteParagraph";
  blockId: BlockId;
  /** The exact start of the paragraph's `final` text: its first 40 characters, or all of it when shorter. */
  startsWith: string;
}

/** Attach a comment to text in a paragraph. */
export interface AgentCommentEdit {
  op: "comment";
  blockId: BlockId;
  /** The exact existing text to anchor to. Empty anchors to the whole paragraph. */
  find: string;
  occurrence?: number;
  /** The comment text. */
  text: string;
}

export type AgentDocxEdit = AgentReplaceTextEdit | AgentInsertParagraphEdit | AgentDeleteParagraphEdit | AgentCommentEdit;

/** A value in an agent sheet edit. A string that starts with `=` is a formula. */
export type AgentCellInput = string | number | boolean | null;

/** Set one cell. */
export interface AgentSetCellEdit {
  op: "setCell";
  /** Sheet name. */
  sheet: string;
  /** A1 address, for example `B7`. */
  cell: string;
  value: AgentCellInput;
  /**
   * What the agent saw in the cell: the formula with its leading `=` for a
   * formula cell, else the display text; an empty string for an empty cell.
   * When given and different from the cell, the edit is rejected as `stale_reference`.
   */
  expect?: string;
}

/** Set a block of cells from its top-left corner, row by row. */
export interface AgentSetRangeEdit {
  op: "setRange";
  sheet: string;
  /** A1 address of the top-left cell. */
  start: string;
  values: AgentCellInput[][];
}

/** Clear the contents of a range. */
export interface AgentClearRangeEdit {
  op: "clearRange";
  sheet: string;
  /** A1 range, for example `A2:C9`. */
  range: string;
}

export type AgentSheetEdit = AgentSetCellEdit | AgentSetRangeEdit | AgentClearRangeEdit;

/** The JSON object an agent returns. */
export type AgentEditEnvelope =
  | { kind: "docx"; edits: AgentDocxEdit[]; summary?: string }
  | { kind: "sheet"; edits: AgentSheetEdit[]; summary?: string };

export type AgentEditKind = AgentEditEnvelope["kind"];

export type AgentParseErrorCode =
  /** No JSON object in the text. */
  | "no_json"
  /** JSON that does not parse. */
  | "invalid_json"
  /** JSON that is not a valid envelope; `path` names the first bad value. */
  | "invalid_shape"
  /** The envelope is for the other kind of document. */
  | "wrong_kind"
  /** The text, the number of edits or one string is over its bound. */
  | "too_large";

export interface AgentParseError {
  code: AgentParseErrorCode;
  /** For logs and for telling the agent what to fix. Never contains document text. */
  message: string;
  /** JSON path of the offending value, for example `edits[2].find`, or null. */
  path: string | null;
}

export type AgentParseResult = { ok: true; envelope: AgentEditEnvelope } | { ok: false; error: AgentParseError };

/**
 * Reads an agent answer. Accepts the bare JSON object, the object inside a
 * fenced code block, or the object surrounded by prose (the first balanced
 * top-level `{…}` is taken). Validates every field, rejects unknown `op`
 * values and unknown properties, and never throws.
 *
 * Bounds (`too_large`): 1 MiB of text, 500 edits, 20 000 characters per
 * string, 10 000 cells per `setRange`.
 *
 * Also `invalid_shape`: an empty `find` of `replaceText`, an `occurrence`
 * or `headingLevel` that is not a whole number in range, a cell address or
 * range that is not A1 notation, a number that is not finite, and a control
 * character other than tab and line break in document text.
 */
export type ParseAgentEdits = (text: string, expectedKind?: AgentEditKind) => AgentParseResult;

/**
 * Instructions for a system prompt: the envelope format for one kind of
 * document, with the rules above and a short example. Plain text.
 */
export type AgentEditInstructions = (kind: AgentEditKind) => string;

export type RejectedEditCode =
  /** The block or sheet does not exist. */
  | "not_found"
  /** The quoted text is not there, or `expect` does not match. */
  | "stale_reference"
  /** The quoted text occurs more than once and no `occurrence` was given. */
  | "ambiguous"
  /** The edit cannot apply to that block or cell: wrong block type, bad address, a formula that does not parse. */
  | "invalid_operation";

export interface RejectedEdit {
  /** Index of the edit in the envelope. */
  index: number;
  code: RejectedEditCode;
  message: string;
}

/**
 * Document operations for the edits that resolved, and the edits that did not.
 * `ops` are ordered for `DocxDocument.applyOps` (from the end of the document
 * to the start) and `opEditIndexes[i]` is the envelope index of `ops[i]`.
 */
export interface DocxEditPlan {
  ops: DocxOp[];
  opEditIndexes: number[];
  rejected: RejectedEdit[];
}

/**
 * Resolves agent edits against the current document without changing it.
 * `replaceText` becomes a `replaceRange` with word granularity over the
 * words that differ, so text the agent repeated around its change is not
 * marked. Quoted text is matched in the `final` view as a description shows
 * it (on one line, without inline objects) and mapped to markup positions.
 * Apply the plan with `document.applyOps(plan.ops, { track: true, … })`.
 *
 * Rejected as `invalid_operation` besides the cases on {@link RejectedEditCode}:
 * a change that would remove an inline object (an image, a note mark), a
 * replacement equal to the text it replaces, and an edit that overlaps an
 * earlier edit of the same paragraph (the earlier one is kept).
 *
 * Every operation of the plan has been tried on the document as a tracked
 * edit and taken back with `snapshot`/`restore`, so applying the plan does
 * not throw. The trial uses up revision ids: the ids of the real apply are
 * not the first free ones.
 */
export type ToDocxOps = (document: DocxDocument, edits: readonly AgentDocxEdit[]) => DocxEditPlan;

/** One cell edit with resolved coordinates. Exactly one of `value` and `formula` is meaningful: `formula` null means a literal. */
export interface ResolvedSheetEdit {
  /** Index of the edit in the envelope it came from. */
  editIndex: number;
  sheet: SheetId;
  row: number;
  col: number;
  value: CellValue;
  /** Formula text without the leading `=`, or null. */
  formula: string | null;
}

export interface SheetEditPlan {
  /** Cell edits in envelope order; a `setRange` or `clearRange` expands to one entry per cell. */
  edits: ResolvedSheetEdit[];
  rejected: RejectedEdit[];
}

/**
 * Resolves agent edits against the current workbook without changing it.
 * A `clearRange` is cut down to the used part of the sheet (a whole column
 * clears its used rows) and is rejected as `invalid_operation` when more
 * than 10 000 cells remain. An edit to a cell that an array formula fills
 * (`Cell.arrayRange`) is rejected as `invalid_operation`: a proposal cannot
 * change an array formula. An edit to a cell that already has a pending
 * change is rejected as `invalid_operation` too: resolve that change first.
 */
export type ToSheetEdits = (workbook: Workbook, edits: readonly AgentSheetEdit[]) => SheetEditPlan;

/**
 * Applies resolved edits inside a new proposal, ends the proposal and
 * recalculates. Returns the proposal id and the ids of the recorded changes.
 * Throws `invalid_operation` when a proposal is already open, or before
 * writing anything when an edit touches a cell with a pending change. All or
 * nothing: when an edit fails, the changes recorded so far are rejected, the
 * proposal is ended and the error is thrown again.
 */
export type ApplySheetEdits = (
  workbook: Workbook,
  edits: readonly ResolvedSheetEdit[],
  proposal: ProposalOptions,
) => { proposalId: string; changeIds: string[] };

/** The value exports of `src/agent/index.ts`. */
export interface AgentModule {
  describeDocx: DescribeDocx;
  describeSheet: DescribeSheet;
  parseAgentEdits: ParseAgentEdits;
  agentEditInstructions: AgentEditInstructions;
  toDocxOps: ToDocxOps;
  toSheetEdits: ToSheetEdits;
  applySheetEdits: ApplySheetEdits;
}
