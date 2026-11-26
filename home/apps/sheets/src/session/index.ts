/**
 * The Sheets session: one open spreadsheet with undo, calculation and saving.
 *
 * ```ts
 * import { SessionHost } from "./session";
 *
 * const host = new SessionHost({ files: window.MatrixOS.files, db: window.MatrixOS.db });
 * const opened = await host.open("Documents/Budget.xlsx");   // also .csv and .tsv
 * if (opened.status !== "opened") return;                    // superseded | unsaved | error
 * const session = opened.session;
 *
 * session.subscribe((event) => { ... });         // "change": cells changed; "state": getState() changed
 * session.getState();                            // dirty, saveState, canUndo, activeSheetId, ...
 * session.setCellInput(sheet, { row: 0, col: 0 }, "=SUM(B1:B9)");
 * session.undo();
 * ```
 *
 * Editing
 * - Every edit method returns `{ ok: true }` or `{ ok: false, code, message }`
 *   with a message that is safe to show. Nothing throws for a bad edit.
 * - Each call is one undo step. `transact(label, (tx) => ...)` groups several
 *   edits into one step: use `tx.workbook` for cell edits and the `tx` methods
 *   for rows, columns, sizes, merges, frozen panes and sheet names.
 * - After every edit, undo and redo the workbook is recalculated before
 *   listeners hear of it; `event.recalculated` lists the cells whose value
 *   changed.
 * - Proposed changes (the agent's edits) are made with
 *   `session.mutate((workbook) => { workbook.beginProposal(...); ...; workbook.endProposal(); })`
 *   and resolved with `acceptChanges` / `rejectChanges`. These, `addSheet` and
 *   `removeSheet` cannot be undone here and clear the undo history.
 * - Editing `session.workbook` directly still recalculates and marks the
 *   session dirty, but it clears the undo history: prefer the methods above.
 *
 * Saving
 * - `save()` writes with the version the file had when it was read. When the
 *   file changed on disk the outcome is `conflict` and `saveState` stays
 *   `"conflict"`: the local workbook stays on screen and no further save is
 *   tried. Offer `reload()` (take the file, drop local edits) or `saveCopy()`
 *   (write "name (copy).xlsx" beside it and continue there).
 * - With a path, edits are saved automatically after a quiet period
 *   (`autosaveDelayMs`, default 1500 ms); `setAutosave(false)` turns it off.
 *   A save that settles after `dispose()` or `reload()` changes nothing.
 * - `.csv` and `.tsv` are written back as text in the delimiter, line ending
 *   and byte-order mark they were read with. They hold the values of the
 *   first sheet only (`state.valuesOnlyFormat`); `saveAs("x.xlsx")` keeps
 *   everything.
 * - `session.recents.list()` gives the recently opened files.
 *
 * Local documents
 * - `host.openLocal(name, bytes)` opens a file chosen on this computer:
 *   `state.source` is `"local"`, the path is null and autosave is off. Save
 *   it with `exportSessionFile(session)` (bytes, name, MIME type, mark)
 *   followed by `session.markDownloaded(file.mark)`, which leaves edits made
 *   during the export unsaved; `session.saveAs(path)` makes it a Matrix
 *   document with autosave. `exportSessionFile(session, "xlsx")` downloads a
 *   copy of any document.
 *
 * Undo of an edit that removed an array formula restores its values and the
 * formula of its first cell as an ordinary formula.
 */

export { SheetSession } from "./session";
export { createSheetSession, openSheetSession } from "./open";
export { exportSessionFile, openLocalSheetSession } from "./local";
export type { ExportedFile } from "./local";
export { SessionHost } from "./host";
export type { EditorCommit, HostCloseResult, HostOpenResult, HostState } from "./host";
export { SheetSessionError, copyPath, fileName, formatOfPath, isValidFilePath, sessionMessage } from "./file-io";
export { MAX_RECENT_FILES, RECENT_FILES_TABLE, createRecentFiles } from "./recents";
export type { RecentFile, RecentFiles } from "./recents";
export { LARGE_RANGE_CELLS, clampRange, rangeArea, styleAsPatch } from "./edits";
export type { SessionCellEdit, Transaction } from "./edits";
export { DEFAULT_AUTOSAVE_DELAY_MS } from "./save";
export type {
  DocumentSource,
  EditResult,
  SaveOutcome,
  SaveState,
  SessionChangeCause,
  SessionDb,
  SessionDeps,
  SessionErrorCode,
  SessionEvent,
  SessionFailure,
  SessionFiles,
  SessionListener,
  SessionState,
  SessionTimers,
  SheetFileFormat,
} from "./types";
