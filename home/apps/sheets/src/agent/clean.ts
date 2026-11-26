/**
 * Cleaning and normalising one column. Code does what it can be sure of
 * (spaces, invisible characters, numbers typed as text); with an instruction,
 * the model proposes the rest, limited to the column. Everything lands in one
 * proposal.
 */

import { askAboutWorkbook } from "./ai";
import { editTargets, runProposal, validateReply, writeResolved } from "./apply";
import { type AgentContext, type ProposalOutcome, isoNow } from "./context";
import { type CellRange, type CellValue, type ResolvedSheetEdit, type SheetId, type Workbook, agentEditInstructions, columnLabel } from "./engine";
import { describeSheet } from "./engine";
import { buildPrompt, cleanRequest, contentBudget } from "./prompt";
import { MAX_PROPOSED_CELLS } from "./limits";

const INVISIBLE = /[​-‍⁠﻿­]/g;
const NUMBER_TEXT = /^(\()?\s*([-+])?\s*[£$€¥]?\s*(\d{1,3}(?:,\d{3})+|\d+)?(\.\d+)?\s*(%)?\s*(\))?$/;

/** The number a text means, or null: `"1,200"`, `"£50"`, `"(300)"`, `"12%"`. */
export function numberFromText(text: string): number | null {
  const match = NUMBER_TEXT.exec(text.trim());
  if (match === null) return null;
  const [, open, sign, whole, fraction, percent, close] = match;
  if (whole === undefined && fraction === undefined) return null;
  if ((open === undefined) !== (close === undefined)) return null;
  let value = Number(`${(whole ?? "0").replace(/,/g, "")}${fraction ?? ""}`);
  if (!Number.isFinite(value)) return null;
  if (percent !== undefined) value /= 100;
  if (sign === "-" || open !== undefined) value = -value;
  return value;
}

/** Text with invisible characters removed and runs of white space made one space. */
export function tidyText(text: string): string {
  return text.replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
}

/** The rows of a column inside the used range of its sheet, or null for an empty sheet. */
export function columnRange(workbook: Workbook, sheet: SheetId, col: number): CellRange | null {
  const used = workbook.getSheet(sheet).dimensions;
  if (used === null) return null;
  return { start: { row: used.start.row, col }, end: { row: used.end.row, col } };
}

/**
 * The deterministic clean-up of a column: tidies text, and when most of the
 * column is numeric, turns numbers typed as text into numbers. Formula cells
 * and cells with a pending change are left alone. Returns edits for the cells
 * that change.
 */
export function normaliseColumn(workbook: Workbook, sheet: SheetId, col: number): ResolvedSheetEdit[] {
  const range = columnRange(workbook, sheet, col);
  if (range === null) return [];
  const cells = workbook.getRange(sheet, range).map((row) => row[0]!);
  let numeric = 0;
  let filled = 0;
  for (const cell of cells) {
    if (cell.formula !== null || cell.value === null) continue;
    filled += 1;
    if (typeof cell.value === "number" || (typeof cell.value === "string" && numberFromText(cell.value) !== null)) numeric += 1;
  }
  const numericColumn = filled > 0 && numeric / filled >= 0.6;
  const edits: ResolvedSheetEdit[] = [];
  cells.forEach((cell, index) => {
    // A cell with a pending change keeps it: its proposal is reviewed on its own.
    if (cell.formula !== null || typeof cell.value !== "string" || cell.pendingChangeId !== null) return;
    const tidy = tidyText(cell.value);
    const asNumber = numericColumn ? numberFromText(tidy) : null;
    const value: CellValue = asNumber ?? (tidy === "" ? null : tidy);
    if (value === cell.value) return;
    edits.push({ editIndex: -1, sheet, row: range.start.row + index, col, value, formula: null });
  });
  return edits.slice(0, MAX_PROPOSED_CELLS);
}

/**
 * Cleans a column. Without an instruction only the deterministic clean-up
 * runs. With one, the model's edits are validated (they must stay inside the
 * column) and override the deterministic ones for the same cells; when they
 * are not valid nothing is applied.
 */
export async function cleanColumn(ctx: AgentContext, sheet: SheetId, col: number, instruction = ""): Promise<ProposalOutcome> {
  const workbook = ctx.session.workbook;
  const label = `Assistant: clean column ${columnLabel(col)}`;
  const range = columnRange(workbook, sheet, col);
  if (range === null) return { status: "no_changes", summary: "The column is empty." };
  let modelEdits: ResolvedSheetEdit[] = [];
  let summary = "";
  if (instruction.trim() !== "") {
    const parts = {
      task: `Clean and normalise column ${columnLabel(col)} as the owner asks: make spelling, case, units and formats consistent. Change only cells of column ${columnLabel(col)}; keep the header.`,
      rules: ["Change a cell only when it needs it, and give \"expect\" with what you saw."],
      format: agentEditInstructions("sheet"),
      request: cleanRequest(instruction),
    };
    const blockLabel = `Column ${columnLabel(col)}`;
    const description = describeSheet(workbook, sheet, range, { maxChars: Math.max(1, contentBudget(parts, [blockLabel])) });
    // Rejects a reply when the workbook changed while the model was answering.
    const reply = await askAboutWorkbook(ctx, buildPrompt({ ...parts, blocks: [{ label: blockLabel, text: description.text }] }));
    const checked = validateReply(ctx.session.workbook, reply, { sheet, range });
    if (!checked.ok && checked.reason !== "empty") return { status: "invalid", messages: checked.messages };
    if (checked.ok) {
      modelEdits = checked.edits;
      summary = checked.summary;
    }
  }
  const byCell = new Map<number, ResolvedSheetEdit>();
  for (const edit of normaliseColumn(ctx.session.workbook, sheet, col)) byCell.set(edit.row, edit);
  for (const edit of modelEdits) byCell.set(edit.row, edit);
  const edits = [...byCell.values()].sort((a, b) => a.row - b.row);
  if (edits.length === 0) return { status: "no_changes", summary: summary || "The column is already clean." };
  const record = runProposal(ctx.session, label, isoNow(ctx), editTargets(edits), (wb) => {
    for (const edit of edits) writeResolved(wb, edit);
  }, ctx.log);
  if (record.changeIds.length === 0) return { status: "no_changes", summary: "The column is already clean." };
  return { status: "proposed", ...record, label, summary: summary || `Tidied ${record.changeIds.length} cells in column ${columnLabel(col)}.` };
}
