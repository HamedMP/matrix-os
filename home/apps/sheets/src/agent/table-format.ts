/**
 * Deterministic actions that need no model: formatting a range as a table
 * and fixing a typed-in total by linking it to the formula it disagrees with.
 * Both land in a proposal, so the owner reviews them like any other change.
 */

import { MERGED_CELLS, coveredIn } from "../grid/merge-guard";
import { runProposal } from "./apply";
import type { Finding } from "./checks";
import { type AgentContext, type ProposalOutcome, type SheetSelection, isoNow } from "./context";
import { type CellRange, type CellStylePatch, type SheetId, type Workbook, formatA1, formatA1Range } from "./engine";
import { MAX_PROPOSED_CELLS } from "./limits";
import { sheetRef } from "./sheet-read";

const LINE = { style: "thin" as const, color: "#B7C3D0" };
export const TABLE_HEADER: CellStylePatch = {
  font: { bold: true, color: "#FFFFFF" },
  fill: { color: "#2F5D8A" },
  border: { top: LINE, right: LINE, bottom: LINE, left: LINE },
};
export const TABLE_BAND: CellStylePatch = { fill: { color: "#EEF3F8" }, border: { top: LINE, right: LINE, bottom: LINE, left: LINE } };
export const TABLE_BODY: CellStylePatch = { border: { top: LINE, right: LINE, bottom: LINE, left: LINE } };

/** The selection cut to the used part of the sheet, or null when nothing is left. */
export function tableRange(workbook: Workbook, sheet: SheetId, range: CellRange): CellRange | null {
  const used = workbook.getSheet(sheet).dimensions;
  if (used === null) return null;
  const single = range.start.row === range.end.row && range.start.col === range.end.col;
  // One cell selected: format the whole used block.
  const wanted = single ? used : range;
  const cut: CellRange = {
    start: { row: Math.max(wanted.start.row, used.start.row), col: Math.max(wanted.start.col, used.start.col) },
    end: { row: Math.min(wanted.end.row, used.end.row), col: Math.min(wanted.end.col, used.end.col) },
  };
  return cut.start.row > cut.end.row || cut.start.col > cut.end.col ? null : cut;
}

/** Header row, banded body rows and thin borders, proposed for review. */
export function formatAsTable(ctx: AgentContext, selection: SheetSelection): ProposalOutcome {
  const workbook = ctx.session.workbook;
  const range = tableRange(workbook, selection.sheet, selection.range);
  if (range === null) return { status: "no_changes", summary: "There is nothing to format in the selection." };
  const cells = (range.end.row - range.start.row + 1) * (range.end.col - range.start.col + 1);
  if (cells > MAX_PROPOSED_CELLS) return { status: "invalid", messages: [`Select at most ${MAX_PROPOSED_CELLS} cells to format as a table.`] };
  const label = `Assistant: format ${formatA1Range(range)} as a table`;
  const record = runProposal(ctx.session, label, isoNow(ctx), [{ sheet: selection.sheet, range }], (wb) => {
    const row = (r: number): CellRange => ({ start: { row: r, col: range.start.col }, end: { row: r, col: range.end.col } });
    wb.setStyle(selection.sheet, row(range.start.row), TABLE_HEADER);
    for (let r = range.start.row + 1; r <= range.end.row; r++) {
      wb.setStyle(selection.sheet, row(r), (r - range.start.row) % 2 === 0 ? TABLE_BAND : TABLE_BODY);
    }
  }, ctx.log);
  if (record.changeIds.length === 0) return { status: "no_changes", summary: "The range is already formatted as a table." };
  return { status: "proposed", ...record, label, summary: `Header, banded rows and borders for ${formatA1Range(range)}.` };
}

/**
 * Replaces a typed-in total that disagrees with a formula total by a formula
 * that refers to it, so the two can no longer drift apart.
 */
export function fixFinding(ctx: AgentContext, finding: Finding): ProposalOutcome {
  const source = finding.related?.[0];
  if (finding.kind !== "total-mismatch" || source === undefined) return { status: "invalid", messages: ["This finding has no formula to link to; fix it by hand."] };
  const workbook = ctx.session.workbook;
  const cell = workbook.getCell(finding.sheet, finding);
  if (cell.formula !== null || cell.value !== finding.actual) return { status: "invalid", messages: ["The cell has changed since the check. Run the check again."] };
  // A total a merged cell hides cannot be seen: changing it would happen out of sight.
  const at = { row: finding.row, col: finding.col };
  if (coveredIn(workbook.getSheet(finding.sheet).mergedRanges, { start: at, end: at })(at.row, at.col)) return { status: "invalid", messages: [MERGED_CELLS] };
  const sourceName = workbook.getSheet(source.sheet).name;
  const formula = source.sheet === finding.sheet ? formatA1(source) : `${sheetRef(sourceName)}!${formatA1(source)}`;
  const label = `Assistant: link ${finding.location} to its calculation`;
  const record = runProposal(ctx.session, label, isoNow(ctx), [{ sheet: finding.sheet, range: { start: at, end: at } }], (wb) => wb.setFormula(finding.sheet, at, formula), ctx.log);
  return { status: "proposed", ...record, label, summary: `${finding.location} becomes =${formula}.` };
}
