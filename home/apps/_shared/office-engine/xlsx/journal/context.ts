/** State shared by the parts of one workbook's change journal. */

import type { SheetInfo, Workbook } from "../../api/xlsx.js";
import type { WorkbookInternals, WorkbookJournal } from "../workbook/internals.js";
import type { JournalStore } from "./store.js";
import type { JournalWarning, RewriteRecord } from "./types.js";

/** The workbook's own sheet and structure methods, before the journal wraps them. */
export interface OriginalMethods {
  insertRows: Workbook["insertRows"];
  deleteRows: Workbook["deleteRows"];
  insertColumns: Workbook["insertColumns"];
  deleteColumns: Workbook["deleteColumns"];
  addSheet: Workbook["addSheet"];
  renameSheet: Workbook["renameSheet"];
  removeSheet: Workbook["removeSheet"];
}

export interface JournalContext {
  readonly internals: WorkbookInternals;
  readonly workbook: Workbook;
  readonly store: JournalStore;
  readonly original: OriginalMethods;
  /** The journal object attached to the workbook; the wrappers and the listener act only while it is attached. */
  readonly self: WorkbookJournal;
  readonly date1904: boolean;
  readonly warnings: JournalWarning[];
  /** Id of the open proposal, or null. */
  open: string | null;
  /** Above 0 while the journal itself edits the workbook (rejecting): cell edits are not recorded. */
  suppress: number;
  /** Collects formula rewrites while a proposed structural edit runs. */
  capture: RewriteRecord[] | null;
  captureOverflow: boolean;
}

export function isActive(ctx: JournalContext): boolean {
  return ctx.internals.getJournal() === ctx.self;
}

/** The sheet, or null when it no longer exists. */
export function sheetOrNull(ctx: JournalContext, sheet: string): SheetInfo | null {
  return ctx.internals.hasSheet(sheet) ? ctx.workbook.getSheet(sheet) : null;
}
