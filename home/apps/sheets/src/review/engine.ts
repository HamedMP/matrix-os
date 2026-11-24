/**
 * What change review needs from the document engine beyond `../session/engine`:
 * the typed journal list. Kept in one file so a change of the engine's layout
 * touches review in one place only.
 */

export { formatA1, isOfficeError, listJournalChanges } from "../../../_shared/office-engine/index";
export type { JournalChange, JournalChangeKind } from "../../../_shared/office-engine/xlsx/index";
export type { CellAddress, CellRange, ResolveChangesResult, SheetId, Workbook } from "../../../_shared/office-engine/index";
