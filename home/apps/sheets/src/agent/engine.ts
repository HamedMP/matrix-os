/**
 * What the Sheets assistant needs from the document engine. Kept in one file
 * so a change of the engine's layout touches the assistant in one place only.
 */

export {
  OfficeError,
  agentEditInstructions,
  applySheetEdits,
  columnLabel,
  describeSheet,
  formatA1,
  formatA1Range,
  isOfficeError,
  listJournalChanges,
  parseA1,
  parseA1Range,
  parseAgentEdits,
  toSheetEdits,
} from "../../../_shared/office-engine/index";

export type {
  AgentEditEnvelope,
  AgentParseError,
  AgentSheetEdit,
  Cell,
  CellAddress,
  CellRange,
  CellStylePatch,
  CellValue,
  ProposalOptions,
  RejectedEdit,
  ResolvedSheetEdit,
  SheetCellRef,
  SheetId,
  Workbook,
} from "../../../_shared/office-engine/index";
