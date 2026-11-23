import {
  MAX_COLS, MAX_ROWS, applySheetEdits, describeSheet, formatA1, formatA1Range, openXlsx, parseA1Range, parseAgentEdits, parseCsv,
  toSheetEdits,
} from "@matrix-os/office";
import type { AgentSheetEdit, CellRange, CellValue, RejectedEdit, SheetInfo, Workbook } from "@matrix-os/office";
import {
  OFFICE_MAX_LISTED_CHANGES, OFFICE_MAX_RANGE_CELLS,
  type OfficeCell, type OfficeCellChange, type OfficeCellValue, type OfficeSheetEdit, type OfficeSheetInfo,
} from "@matrix-os/contracts/office-documents";
import { OfficeDocumentError } from "./document-error.js";

/** Pure operations on an opened workbook. No file I/O; the service loads and saves. */

export function isCsvPath(path: string): boolean {
  return path.toLowerCase().endsWith(".csv");
}

export async function loadWorkbook(path: string, bytes: Uint8Array): Promise<Workbook> {
  if (!isCsvPath(path)) return openXlsx(bytes);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (error: unknown) {
    throw new OfficeDocumentError("unsupported_document", "csv is not utf-8", { cause: error });
  }
  return parseCsv(text);
}

export function cellValueJson(value: CellValue): OfficeCellValue {
  if (value !== null && typeof value === "object") return { error: value.code };
  return value;
}

function sheetInfoJson(sheet: SheetInfo): OfficeSheetInfo {
  return {
    id: sheet.id, name: sheet.name, index: sheet.index, state: sheet.state,
    usedRange: sheet.dimensions ? formatA1Range(sheet.dimensions) : null,
    pendingChangeCount: sheet.pendingChangeCount,
  };
}

/** A named sheet, or the first visible one. */
export function pickSheet(workbook: Workbook, name: string | undefined): SheetInfo {
  if (name !== undefined) {
    const sheet = workbook.getSheetByName(name);
    if (!sheet) throw new OfficeDocumentError("not_found", "unknown sheet");
    return sheet;
  }
  const sheets = workbook.listSheets();
  const first = sheets.find((sheet) => sheet.state === "visible") ?? sheets[0];
  if (!first) throw new OfficeDocumentError("unsupported_document", "workbook without sheets");
  return first;
}

function parseRange(text: string): CellRange {
  try { return parseA1Range(text); }
  catch (error: unknown) {
    throw new OfficeDocumentError("invalid_request", "bad range", { cause: error });
  }
}

/** Whole rows and columns are cut down to the used part of the sheet; explicit rectangles are not. */
function boundRange(range: CellRange, sheet: SheetInfo): CellRange | null {
  const wholeColumns = range.start.row === 0 && range.end.row === MAX_ROWS - 1;
  const wholeRows = range.start.col === 0 && range.end.col === MAX_COLS - 1;
  if (!wholeColumns && !wholeRows) return range;
  const used = sheet.dimensions;
  if (!used) return null;
  const start = { row: Math.max(range.start.row, used.start.row), col: Math.max(range.start.col, used.start.col) };
  const end = { row: Math.min(range.end.row, used.end.row), col: Math.min(range.end.col, used.end.col) };
  return start.row > end.row || start.col > end.col ? null : { start, end };
}

export function describeWorkbookSheet(workbook: Workbook, request: { sheet?: string; range?: string; maxChars: number }) {
  const sheet = pickSheet(workbook, request.sheet);
  const range = request.range === undefined ? null : parseRange(request.range);
  const description = describeSheet(workbook, sheet.id, range, { maxChars: request.maxChars });
  return {
    sheets: workbook.listSheets().map(sheetInfoJson),
    sheet: sheet.name,
    range: formatA1Range(description.range),
    text: description.text,
    truncated: description.truncated,
  };
}

export function readWorkbookRange(workbook: Workbook, request: { sheet?: string; range: string }) {
  const sheet = pickSheet(workbook, request.sheet);
  const requested = parseRange(request.range);
  const range = boundRange(requested, sheet);
  if (!range) return { sheet: sheet.name, range: request.range.toUpperCase(), cells: [] as OfficeCell[][] };
  const cells = (range.end.row - range.start.row + 1) * (range.end.col - range.start.col + 1);
  if (cells > OFFICE_MAX_RANGE_CELLS) throw new OfficeDocumentError("invalid_request", "range too large");
  return {
    sheet: sheet.name,
    range: formatA1Range(range),
    cells: workbook.getRange(sheet.id, range).map((row) => row.map((cell): OfficeCell => ({
      value: cellValueJson(cell.value), formula: cell.formula, display: cell.display, pendingChangeId: cell.pendingChangeId,
    }))),
  };
}

export interface SheetEditOutcome {
  changed: boolean;
  proposalId: string | null;
  changeIds: string[];
  appliedEdits: number[];
  rejected: Array<{ index: number; code: RejectedEdit["code"] }>;
}

function engineSheetEdits(edits: readonly OfficeSheetEdit[]): AgentSheetEdit[] {
  const parsed = parseAgentEdits(JSON.stringify({ kind: "sheet", edits }), "sheet");
  if (!parsed.ok) throw new OfficeDocumentError("invalid_request", `agent edits: ${parsed.error.code} at ${parsed.error.path ?? "-"}`);
  if (parsed.envelope.kind !== "sheet") throw new OfficeDocumentError("invalid_request", "agent edits: wrong kind");
  return parsed.envelope.edits;
}

/** Records agent edits as one proposal in the change journal. Edits that do not resolve are reported, never applied. */
export function proposeWorkbookEdits(
  workbook: Workbook,
  edits: readonly OfficeSheetEdit[],
  proposal: { author: string; date: string; label: string },
): SheetEditOutcome {
  const plan = toSheetEdits(workbook, engineSheetEdits(edits));
  const rejected = plan.rejected.map(({ index, code }) => ({ index, code }));
  if (plan.edits.length === 0) return { changed: false, proposalId: null, changeIds: [], appliedEdits: [], rejected };
  const { proposalId, changeIds } = applySheetEdits(workbook, plan.edits, proposal);
  const appliedEdits = [...new Set(plan.edits.map((edit) => edit.editIndex))].sort((a, b) => a - b);
  return { changed: changeIds.length > 0, proposalId: changeIds.length > 0 ? proposalId : null, changeIds, appliedEdits, rejected };
}

export function listWorkbookChanges(workbook: Workbook) {
  const all = workbook.listChanges();
  const names = new Map(workbook.listSheets().map((sheet) => [sheet.id, sheet.name]));
  const changes = all.slice(0, OFFICE_MAX_LISTED_CHANGES).map((change): OfficeCellChange => ({
    id: change.id,
    proposalId: change.proposalId,
    sheet: names.get(change.sheet) ?? change.sheet,
    cell: formatA1({ row: change.row, col: change.col }),
    author: change.author,
    date: change.date,
    label: change.label,
    oldValue: cellValueJson(change.oldValue),
    newValue: cellValueJson(change.newValue),
    oldFormula: change.oldFormula,
    newFormula: change.newFormula,
  }));
  const proposals = workbook.listProposals().map((proposal) => ({
    id: proposal.id, author: proposal.author, date: proposal.date, label: proposal.label, pendingCount: proposal.pendingCount,
  }));
  return { changes, proposals, total: all.length, truncated: all.length > changes.length };
}

export function resolveWorkbookChanges(workbook: Workbook, ids: readonly string[] | "all", accept: boolean) {
  const result = accept ? workbook.acceptChanges(ids) : workbook.rejectChanges(ids);
  if (result.restored.length > 0) workbook.recalc();
  return { resolvedIds: result.resolvedIds, staleIds: result.stale };
}
