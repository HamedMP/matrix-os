/**
 * Engine-internal access to a workbook, for the change journal.
 *
 * Not part of the public `XlsxModule`. A journal implements
 * {@link WorkbookJournal}; every proposal method of a `Workbook` delegates
 * to the journal attached to it. The journal reads and restores cells with
 * `readRawCell` / `writeRawCell` (which tell no listener) and follows edits
 * with `onCellMutation`:
 *
 * ```ts
 * const internals = getWorkbookInternals(workbook);
 * const stop = internals.onCellMutation((m) => record(m.sheet, m.row, m.col, m.before, m.after));
 * internals.setJournal(journal);
 * ```
 *
 * To have a journal on every handle that `openXlsx`, `createXlsx` and
 * `parseCsv` return, register a {@link JournalProvider}:
 *
 * ```ts
 * setJournalProvider({
 *   open: async (internals) => loadJournal(internals, await internals.readPartText("/matrix/changeJournal.json")),
 *   create: (internals) => newJournal(internals),
 * });
 * ```
 *
 * Without a journal `beginProposal` throws `invalid_operation`, the lists
 * are empty and no cell has a pending change.
 */

export type {
  CellMutation,
  CellMutationListener,
  JournalProvider,
  RawCell,
  WorkbookInternals,
  WorkbookJournal,
} from "./workbook/internals.js";
export { attachJournal, getJournalProvider, getWorkbookInternals, setJournalProvider } from "./workbook/internals.js";
