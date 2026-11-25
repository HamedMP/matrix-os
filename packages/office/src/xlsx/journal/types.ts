/**
 * Types and constants of the cell change journal.
 *
 * The public contract is `Workbook` in `../../api/xlsx.ts`. Everything here
 * adds to it: `listChanges()` returns {@link JournalChange} objects (a
 * `CellChange` with a kind, display texts and a stale flag) and
 * `rejectChanges()` returns a {@link JournalResolveResult}.
 */

import type { CellChange, CellRange, ResolveChangesResult, SheetId } from "../../api/xlsx.js";
import type { SheetFeatureState } from "../workbook/features.js";
import type { RawCell } from "../workbook/internals.js";

/** Where the journal is stored in the package. */
export const JOURNAL_PART_NAME = "/matrix/changeJournal.json";
export const JOURNAL_CONTENT_TYPE = "application/vnd.matrix-os.change-journal+json";
/** Type of the relationship from the workbook part to the journal part. */
export const JOURNAL_RELATIONSHIP_TYPE = "https://matrix-os.com/schemas/office/2026/relationships/change-journal";
export const JOURNAL_FORMAT_VERSION = 1;

/** Pending changes a workbook may hold; a proposed edit beyond it throws `limit_exceeded` and is undone. */
export const MAX_PENDING_CHANGES = 100_000;
/** Cells read to keep the content of deleted rows or columns; a larger proposed deletion throws `limit_exceeded`. */
export const MAX_SNAPSHOT_CELLS = 200_000;
/** Formula rewrites kept per structural change; beyond it the reversal relies on the engine's own rewrite. */
export const MAX_REWRITES = 200_000;
/** Merged ranges a structural change keeps; a proposed one on a sheet with more throws `limit_exceeded` before anything changes. */
export const MAX_KEPT_MERGES = 100_000;
/** Defined names a structural change keeps; a proposed one in a workbook with more throws `limit_exceeded` before anything changes. */
export const MAX_KEPT_NAMES = 10_000;
/** Characters of a journal part that are read; a longer part is ignored. */
export const MAX_JOURNAL_TEXT = 64 * 1024 * 1024;
/** Characters of a proposal author or label. */
export const MAX_PROPOSAL_TEXT = 1_000;
/** Characters of a proposal date. */
export const MAX_DATE_TEXT = 64;

export type AxisKind = "insertRows" | "deleteRows" | "insertColumns" | "deleteColumns";
export type JournalChangeKind = "cell" | AxisKind | "addSheet" | "renameSheet";

/**
 * A pending change as `listChanges()` returns it.
 *
 * - `cell`: one cell; `row`, `col` and the old and new fields describe it.
 * - `insertRows` … `deleteColumns`: `row` (for rows) or `col` (for columns)
 *   is the first one inserted or deleted, `count` how many; values are null.
 * - `addSheet`: `newDisplay` is the sheet name.
 * - `renameSheet`: `oldDisplay` and `newDisplay` are the old and new name.
 */
export interface JournalChange extends CellChange {
  kind: JournalChangeKind;
  /** The old content formatted with its number format; empty for an empty cell. */
  oldDisplay: string;
  /** The new content as the grid shows it now. */
  newDisplay: string;
  /** Rows or columns of a structural change; 1 for the other kinds. */
  count: number;
  /** One line for the review list, for example `Insert rows 2-3`. */
  summary: string;
  /**
   * True when the workbook no longer holds the recorded new content (it was
   * changed without the journal seeing it). A stale change is not reverted
   * by `rejectChanges`; accepting it just forgets it.
   */
  stale: boolean;
}

/** What `acceptChanges` and `rejectChanges` return: the contract's result, whose `stale` list the journal fills. */
export type JournalResolveResult = ResolveChangesResult;

export type JournalWarningCode =
  /** The journal part is not JSON, has the wrong shape or breaks the journal's rules. It is ignored. */
  | "journal_unreadable"
  /** The journal part was written by a later format version. It is ignored. */
  | "journal_unsupported_version"
  /** The journal part is larger than {@link MAX_JOURNAL_TEXT}. It is ignored. */
  | "journal_too_large"
  /** A change whose cell or sheet no longer holds the recorded new content. It is dropped. */
  | "change_stale";

/** Something the journal skipped while reading a file. Client-safe: no document text. */
export interface JournalWarning {
  code: JournalWarningCode;
  changeId: string | null;
  sheet: SheetId | null;
  row: number | null;
  col: number | null;
}

export interface ProposalRecord {
  id: string;
  author: string;
  date: string;
  label: string;
  seq: number;
}

interface EntryBase {
  id: string;
  proposalId: string;
  /** Order of recording; reversal goes from the highest to the lowest. */
  seq: number;
  sheet: SheetId;
}

export interface CellEntry extends EntryBase {
  kind: "cell";
  row: number;
  col: number;
  old: RawCell;
  next: RawCell;
}

/** A formula rewritten by a structural edit: position after the edit. */
export interface RewriteRecord {
  sheet: SheetId;
  row: number;
  col: number;
  before: string;
  after: string;
}

/** A defined name rewritten by a structural edit. */
export interface NameRewrite {
  name: string;
  scope: SheetId | null;
  before: string;
  after: string;
}

/** Content of deleted rows or columns, in the coordinates before the deletion. */
export interface BandSnapshot {
  cells: Array<{ row: number; col: number; raw: RawCell }>;
  /** Row heights in points or column widths in characters that differ from the default. */
  sizes: Array<{ index: number; size: number }>;
}

export interface AxisEntry extends EntryBase {
  kind: AxisKind;
  index: number;
  count: number;
  /** Deleted content; null for an insertion. */
  snapshot: BandSnapshot | null;
  /** Null when there were more than {@link MAX_REWRITES}. */
  rewrites: RewriteRecord[] | null;
  names: NameRewrite[];
  /** Merged ranges of the sheet before and after, or null when the edit left them unchanged. */
  merges: { before: CellRange[]; after: CellRange[] } | null;
  /**
   * For a deletion: what the sheet held besides cell content before it (the
   * ranges of formats, validations, links and tables, notes, array formulas,
   * row and column attributes). Null for an insertion and for a sheet with
   * none of it.
   */
  features: SheetFeatureState | null;
}

export interface AddSheetEntry extends EntryBase {
  kind: "addSheet";
  name: string;
}

export interface RenameSheetEntry extends EntryBase {
  kind: "renameSheet";
  oldName: string;
  newName: string;
}

export type JournalEntry = CellEntry | AxisEntry | AddSheetEntry | RenameSheetEntry;

/** The whole journal as it is saved. */
export interface JournalData {
  nextProposal: number;
  nextChange: number;
  nextSeq: number;
  proposals: ProposalRecord[];
  entries: JournalEntry[];
}
