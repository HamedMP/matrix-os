/**
 * The seam between the workbook model and the change journal.
 *
 * The workbook owns cells, parts and calculation. The journal records edits
 * as proposed changes on top of it. The journal reaches the workbook through
 * {@link WorkbookInternals}; the workbook reaches the journal through
 * {@link WorkbookJournal}. Both are re-exported from `../internal.ts`.
 */

import type { OpcPackage, PartName } from "../../api/opc.js";
import type {
  CellAddress,
  CellChange,
  CellValue,
  Proposal,
  ProposalOptions,
  ResolveChangesResult,
  SheetCellRef,
  SheetId,
  StyleId,
  Workbook,
} from "../../api/xlsx.js";
import type { XmlDocument } from "../../api/xml.js";
import { OfficeError } from "../../errors.js";
import type { SheetFeatureState } from "./features.js";

/** The content of a cell that an edit can change. */
export interface RawCell {
  /** The literal value, or the last calculated result of the formula. */
  value: CellValue;
  /** Formula text without the leading `=`, or null for a literal. */
  formula: string | null;
  styleId: StyleId;
}

/**
 * One cell edit.
 * - `edit`: made through a `Workbook` method (`setCell`, `setRange`,
 *   `setFormula`, `setCellInput`, `clearRange`, `setStyle`, `mergeCells`).
 * - `rewrite`: the formula text was rewritten because a sheet was renamed or
 *   removed, or rows or columns were inserted or deleted somewhere. The
 *   meaning of the cell did not change. After a structural edit on the cell's
 *   own sheet, `row` and `col` are the position the cell has now.
 *
 * Results of a calculation are not mutations: `recalc` changes the value of
 * formula cells without telling listeners, and returns what changed.
 */
export interface CellMutation extends SheetCellRef {
  reason: "edit" | "rewrite";
  before: RawCell;
  after: RawCell;
}

export type CellMutationListener = (mutation: CellMutation) => void;

/**
 * What the workbook needs from a change journal. Every `Workbook` proposal
 * method delegates to the attached journal.
 */
export interface WorkbookJournal {
  beginProposal(options: ProposalOptions): string;
  endProposal(): void;
  listProposals(): Proposal[];
  listChanges(): CellChange[];
  acceptChanges(ids: readonly string[] | "all"): ResolveChangesResult;
  rejectChanges(ids: readonly string[] | "all"): ResolveChangesResult;
  /** Id of the pending change on a cell, or null. Used for `Cell.pendingChangeId`. */
  pendingChangeId(sheet: SheetId, row: number, col: number): string | null;
  /** Number of pending changes on a sheet. Structural edits and removal are refused while it is above 0. */
  pendingChangeCount(sheet: SheetId): number;
  /**
   * True between `beginProposal` and `endProposal`. Edits the journal could
   * not take back (to an array formula) are refused while it is true. A
   * journal without it never has such edits refused.
   */
  proposalOpen?(): boolean;
  /**
   * Called by `save()` after recalculation and before the package is
   * serialised: write (or remove) the journal part here.
   */
  beforeSave(): void;
}

/** Workbook access for the change journal. Nothing here is journaled. */
export interface WorkbookInternals {
  readonly workbook: Workbook;
  readonly package: OpcPackage;
  /** Part name of the workbook part, usually `/xl/workbook.xml`. */
  readonly workbookPartName: PartName;
  /** Part name of a sheet. Throws `not_found` for an unknown sheet. */
  sheetPartName(sheet: SheetId): PartName;
  /** True when the sheet exists. */
  hasSheet(sheet: SheetId): boolean;

  /** Value, formula and style of a cell; an empty cell is `{ value: null, formula: null, styleId }`. */
  readRawCell(sheet: SheetId, address: CellAddress): RawCell;
  /**
   * Replaces value, formula and style of a cell without calling the mutation
   * listeners. Cells that depend on it become out of date, as after an edit.
   * A formula is not validated; the value is kept as its cached result.
   */
  writeRawCell(sheet: SheetId, address: CellAddress, cell: RawCell): void;
  /**
   * Registers a listener that runs after every cell edit, once per cell whose
   * value, formula or style changed. Returns the function that removes it.
   * At most 16 listeners.
   */
  onCellMutation(listener: CellMutationListener): () => void;

  /**
   * The parsed XML of a part the workbook holds in memory (the workbook part,
   * worksheets, shared strings, styles), or null for any other part. After
   * changing it through the XML helpers call {@link markPartDirty}.
   */
  getPartXml(name: PartName): XmlDocument | null;
  /** Makes `save()` write the in-memory XML of the part. */
  markPartDirty(name: PartName): void;
  /** Text of any part of the package, or null when it does not exist. */
  readPartText(name: PartName): Promise<string | null>;

  /**
   * What rows or columns about to be deleted take from the sheet besides
   * the content and sizes of their cells (the ranges of formats,
   * validations, links and tables, notes, array formulas, row and column
   * attributes), or null when the sheet has none of it. Plain data that can
   * be saved. Throws `limit_exceeded` when there is too much to keep.
   */
  captureSheetFeatures(sheet: SheetId, axis: "row" | "col", index: number, count: number): SheetFeatureState | null;
  /** False when a state read from a file cannot be used. */
  readableSheetFeatures(features: SheetFeatureState): boolean;
  /** Puts a sheet back into a captured state, once the deleted rows or columns are inserted again. */
  restoreSheetFeatures(sheet: SheetId, features: SheetFeatureState): void;
  /** Applies a formula rewrite (a rename, a removed sheet, moved rows) to the formulas inside a captured state. */
  rewriteSheetFeatures(features: SheetFeatureState, rewrite: (text: string) => string): SheetFeatureState;

  /** Attaches the journal that serves the proposal methods of the workbook. */
  setJournal(journal: WorkbookJournal | null): void;
  getJournal(): WorkbookJournal | null;
}

const registry = new WeakMap<object, WorkbookInternals>();

/** Called by the workbook implementation for each handle it creates. */
export function registerInternals(workbook: Workbook, internals: WorkbookInternals): void {
  registry.set(workbook, internals);
}

/** The internals of a handle made by `openXlsx`, `createXlsx` or `parseCsv`. Throws `invalid_argument` for anything else. */
export function getWorkbookInternals(workbook: Workbook): WorkbookInternals {
  const internals = registry.get(workbook);
  if (internals === undefined) {
    throw new OfficeError("invalid_argument", "not a workbook handle of this engine");
  }
  return internals;
}

/** Attaches a journal to a workbook; shorthand for `getWorkbookInternals(workbook).setJournal(journal)`. */
export function attachJournal(workbook: Workbook, journal: WorkbookJournal | null): void {
  getWorkbookInternals(workbook).setJournal(journal);
}

/**
 * How a change journal comes to be attached to every new handle. The journal
 * module implements it; `xlsx/index.ts` asks the registered provider for a
 * journal each time it makes a handle.
 */
export interface JournalProvider {
  /** For a workbook opened from a file: reads the journal part (see `readPartText`) and returns its journal. */
  open(internals: WorkbookInternals): Promise<WorkbookJournal>;
  /** For a new workbook (`createXlsx`, `parseCsv`): returns an empty journal. */
  create(internals: WorkbookInternals): WorkbookJournal;
}

let journalProvider: JournalProvider | null = null;

/** Registers the provider used for handles made from now on; null removes it. */
export function setJournalProvider(provider: JournalProvider | null): void {
  journalProvider = provider;
}

export function getJournalProvider(): JournalProvider | null {
  return journalProvider;
}
