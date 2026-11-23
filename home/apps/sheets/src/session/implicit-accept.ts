/**
 * An owner edit to a cell with a pending proposed change accepts that change
 * (the journal's rule). So that undo can take the edit back completely, the
 * session records the accepted changes in the same undo step:
 *
 * - undo puts the cell back to its old content and proposes the new content
 *   again with the original author, date and label, so the change is pending
 *   for review once more and reject restores the original;
 * - redo accepts those changes again before the owner's content returns.
 *
 * The change gets a new id when it is proposed again; one proposal is made
 * for each original proposal.
 */

import { styleAsPatch } from "./edits";
import type { CellChange, Workbook, WorkbookInternals } from "./engine";

/** The changes that were pending before an edit and are gone after it. */
export function acceptedBy(before: readonly CellChange[], after: readonly CellChange[]): CellChange[] {
  if (before.length === 0) return [];
  const still = new Set(after.map((change) => change.id));
  return before.filter((change) => !still.has(change.id));
}

function propose(workbook: Workbook, internals: WorkbookInternals, changes: readonly CellChange[]): void {
  const first = changes[0];
  if (first === undefined) return;
  for (const change of changes) {
    internals.writeRawCell(change.sheet, { row: change.row, col: change.col }, { value: change.oldValue, formula: change.oldFormula, styleId: change.oldStyleId });
  }
  workbook.beginProposal({ author: first.author, date: first.date, label: first.label });
  try {
    for (const change of changes) {
      const address = { row: change.row, col: change.col };
      if (change.newFormula !== null) workbook.setFormula(change.sheet, address, change.newFormula);
      else workbook.setCell(change.sheet, address, change.newValue);
      if (change.newStyleId !== change.oldStyleId) {
        workbook.setStyle(change.sheet, { start: address, end: address }, styleAsPatch(workbook.getStyle(change.newStyleId)));
      }
    }
  } finally {
    workbook.endProposal();
  }
}

/** Undo: proposes the accepted changes again, one proposal per original proposal. */
export function restoreAccepted(internals: WorkbookInternals, changes: readonly CellChange[]): void {
  const groups = new Map<string, CellChange[]>();
  for (const change of changes) {
    const group = groups.get(change.proposalId);
    if (group === undefined) groups.set(change.proposalId, [change]);
    else group.push(change);
  }
  for (const group of groups.values()) propose(internals.workbook, internals, group);
}

/** Redo: accepts the changes pending on the cells again; the content they hold does not change. */
export function acceptAgain(internals: WorkbookInternals, changes: readonly CellChange[]): void {
  const ids: string[] = [];
  for (const change of changes) {
    const id = internals.workbook.getCell(change.sheet, { row: change.row, col: change.col }).pendingChangeId;
    if (id !== null && id !== undefined) ids.push(id);
  }
  if (ids.length > 0) internals.workbook.acceptChanges(ids);
}
