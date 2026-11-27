/**
 * Agent sheet edits resolved against a workbook (`ToSheetEdits`) and applied
 * as one proposal (`ApplySheetEdits`). See `../api/agent.ts`.
 */

import type {
  AgentCellInput,
  AgentSheetEdit,
  ApplySheetEdits,
  RejectedEdit,
  RejectedEditCode,
  ResolvedSheetEdit,
  ToSheetEdits,
} from "../api/agent.js";
import type { CellAddress, CellRange, SheetInfo, Workbook } from "../api/xlsx.js";
import { OfficeError, isOfficeError } from "../errors.js";
import { parseFormula } from "../xlsx/formula/parser/parser.js";
import { MAX_COLS, MAX_ROWS, parseA1, parseA1Range } from "../xlsx/workbook/a1.js";
import { MAX_RANGE_CELLS } from "./limits.js";
import { singleLine } from "./text.js";

class Rejection {
  constructor(
    readonly code: RejectedEditCode,
    readonly message: string,
  ) {}
}

function reject(code: RejectedEditCode, message: string): never {
  throw new Rejection(code, message);
}

function sheetOf(workbook: Workbook, name: string): SheetInfo {
  const sheet = workbook.getSheetByName(name);
  if (sheet === null) reject("not_found", "no sheet has that name");
  return sheet;
}

/** Runs an address parser of the workbook module, turning its error into a rejection. */
function address<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (!isOfficeError(error)) throw error;
    return reject("invalid_operation", "the address is not a cell or range of a sheet");
  }
}

/**
 * The checks every cell an edit writes must pass, so that the edit does not
 * fail the whole proposal later:
 * - A proposal cannot change a cell that an array formula fills: the journal
 *   could not take the change back.
 * - A proposal cannot change a cell that already has a pending change: the
 *   journal would fold the edit into the earlier proposal's change, so the
 *   new proposal could neither list it nor take it back.
 */
function requireWritable(workbook: Workbook, sheet: SheetInfo, at: CellAddress): void {
  const cell = workbook.getCell(sheet.id, at);
  if (cell.arrayRange !== null) reject("invalid_operation", "the cell is part of an array formula");
  if (cell.pendingChangeId !== null) reject("invalid_operation", "the cell has a pending change; accept or reject it first");
}

/** A literal or a formula from what the agent wrote. A string that starts with `=` is a formula. */
function content(input: AgentCellInput): Pick<ResolvedSheetEdit, "value" | "formula"> {
  if (typeof input !== "string" || !input.startsWith("=")) return { value: input, formula: null };
  const formula = input.slice(1).trim();
  if (formula === "") reject("invalid_operation", "the formula is empty");
  try {
    parseFormula(formula);
  } catch (error) {
    if (!isOfficeError(error)) throw error;
    reject("invalid_operation", "the formula does not parse");
  }
  return { value: null, formula };
}

function resolve(workbook: Workbook, edit: AgentSheetEdit, editIndex: number): ResolvedSheetEdit[] {
  const sheet = sheetOf(workbook, edit.sheet);
  switch (edit.op) {
    case "setCell": {
      const at = address(() => parseA1(edit.cell));
      if (edit.expect !== undefined) {
        const cell = workbook.getCell(sheet.id, at);
        const current = cell.formula === null ? singleLine(cell.display) : `=${singleLine(cell.formula)}`;
        if (singleLine(edit.expect).trim() !== current.trim()) reject("stale_reference", "the cell does not hold what was expected");
      }
      requireWritable(workbook, sheet, at);
      return [{ editIndex, sheet: sheet.id, row: at.row, col: at.col, ...content(edit.value) }];
    }
    case "setRange": {
      const start = address(() => parseA1(edit.start));
      const resolved: ResolvedSheetEdit[] = [];
      edit.values.forEach((row, r) => {
        row.forEach((input, c) => {
          const cell: CellAddress = { row: start.row + r, col: start.col + c };
          if (cell.row >= MAX_ROWS || cell.col >= MAX_COLS) reject("invalid_operation", "the values do not fit on the sheet");
          requireWritable(workbook, sheet, cell);
          resolved.push({ editIndex, sheet: sheet.id, row: cell.row, col: cell.col, ...content(input) });
        });
      });
      return resolved;
    }
    case "clearRange": {
      const range = clipToUsed(address(() => parseA1Range(edit.range)), sheet.dimensions);
      if (range === null) return [];
      const height = range.end.row - range.start.row + 1;
      const width = range.end.col - range.start.col + 1;
      if (height * width > MAX_RANGE_CELLS) reject("invalid_operation", `the range holds more than ${MAX_RANGE_CELLS} cells; clear it in parts`);
      const resolved: ResolvedSheetEdit[] = [];
      for (let row = range.start.row; row <= range.end.row; row++) {
        for (let col = range.start.col; col <= range.end.col; col++) {
          requireWritable(workbook, sheet, { row, col });
          resolved.push({ editIndex, sheet: sheet.id, row, col, value: null, formula: null });
        }
      }
      return resolved;
    }
  }
}

/** Cells outside the used part of a sheet are empty already, so a whole column clears only its used rows. */
function clipToUsed(range: CellRange, used: CellRange | null): CellRange | null {
  if (used === null) return null;
  const start = { row: Math.max(range.start.row, used.start.row), col: Math.max(range.start.col, used.start.col) };
  const end = { row: Math.min(range.end.row, used.end.row), col: Math.min(range.end.col, used.end.col) };
  return start.row > end.row || start.col > end.col ? null : { start, end };
}

export const toSheetEdits: ToSheetEdits = (workbook, edits) => {
  const resolved: ResolvedSheetEdit[] = [];
  const rejected: RejectedEdit[] = [];
  edits.forEach((edit, index) => {
    try {
      resolved.push(...resolve(workbook, edit, index));
    } catch (problem) {
      if (!(problem instanceof Rejection)) throw problem;
      rejected.push({ index, code: problem.code, message: problem.message });
    }
  });
  return { edits: resolved, rejected };
};

/**
 * Refuses, before anything is written, an edit to a cell with a pending
 * change: that change belongs to an earlier proposal, so this proposal could
 * neither list the edit nor take it back when a later edit fails.
 */
function requireNoPendingChanges(workbook: Workbook, edits: readonly ResolvedSheetEdit[]): void {
  if (edits.length === 0) return;
  const pending = new Set<string>();
  for (const change of workbook.listChanges()) {
    if (change.row !== null && change.col !== null) pending.add(`${change.sheet}!${change.row}:${change.col}`);
  }
  if (pending.size === 0) return;
  for (const edit of edits) {
    if (pending.has(`${edit.sheet}!${edit.row}:${edit.col}`)) {
      throw new OfficeError("invalid_operation", "a cell of the edits has a pending change; accept or reject it first");
    }
  }
}

export const applySheetEdits: ApplySheetEdits = (workbook, edits, proposal) => {
  requireNoPendingChanges(workbook, edits);
  const proposalId = workbook.beginProposal(proposal);
  const ownChanges = (): string[] =>
    workbook
      .listChanges()
      .filter((change) => change.proposalId === proposalId)
      .map((change) => change.id);
  try {
    for (const edit of edits) {
      const at: CellAddress = { row: edit.row, col: edit.col };
      if (edit.formula !== null) workbook.setFormula(edit.sheet, at, edit.formula);
      else workbook.setCell(edit.sheet, at, edit.value);
    }
  } catch (error) {
    // All or nothing: what the proposal recorded so far is taken back before the error is passed on.
    workbook.endProposal();
    const recorded = ownChanges();
    if (recorded.length > 0) workbook.rejectChanges(recorded);
    workbook.recalc();
    throw error;
  }
  workbook.endProposal();
  workbook.recalc();
  return { proposalId, changeIds: ownChanges() };
};
