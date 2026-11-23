/**
 * Engine-internal access to a workbook, for the change journal.
 *
 * Not part of the public `XlsxModule`. A journal implements
 * {@link WorkbookJournal} and is attached with {@link attachJournal}; it
 * reads and restores cells with `readRawCell` / `writeRawCell` (which are
 * not journaled) and follows edits with `onCellMutation`.
 *
 * ```ts
 * const internals = getWorkbookInternals(workbook);
 * const stop = internals.onCellMutation((m) => record(m.sheet, m.row, m.col, m.before, m.after));
 * internals.setJournal(journal);
 * ```
 */

export type {
  CellMutation,
  CellMutationListener,
  RawCell,
  WorkbookInternals,
  WorkbookJournal,
} from "./workbook/internals.js";
export { attachJournal, getWorkbookInternals } from "./workbook/internals.js";
