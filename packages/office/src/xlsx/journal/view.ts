/** The journal as the review list sees it: proposals and changes as plain data. */

import type { CellValue, Proposal, StyleId } from "../../api/xlsx.js";
import { isOfficeError } from "../../errors.js";
import { formatValue } from "../format/index.js";
import { columnLabel } from "../workbook/a1.js";
import type { JournalContext } from "./context.js";
import { copyValue } from "./record.js";
import { isStale } from "./revert.js";
import type { AxisEntry, JournalChange, JournalEntry } from "./types.js";

function numberFormat(ctx: JournalContext, styleId: StyleId): string {
  try {
    return ctx.workbook.getStyle(styleId).numberFormat;
  } catch (error) {
    // A style id from a file that the style table does not have is shown as General.
    if (isOfficeError(error)) return "General";
    throw error;
  }
}

function display(ctx: JournalContext, value: CellValue, styleId: StyleId): string {
  return value === null ? "" : formatValue(value, numberFormat(ctx, styleId), { date1904: ctx.date1904 });
}

function axisSummary(entry: AxisEntry): string {
  const rows = entry.kind === "insertRows" || entry.kind === "deleteRows";
  const verb = entry.kind.startsWith("insert") ? "Insert" : "Delete";
  const label = (n: number): string => (rows ? String(n + 1) : columnLabel(n));
  const first = label(entry.index);
  if (entry.count === 1) return `${verb} ${rows ? "row" : "column"} ${first}`;
  return `${verb} ${rows ? "rows" : "columns"} ${first}-${label(entry.index + entry.count - 1)}`;
}

function viewOf(ctx: JournalContext, entry: JournalEntry): JournalChange {
  const proposal = ctx.store.proposals.get(entry.proposalId);
  const stale = isStale(ctx, entry);
  const base = {
    id: entry.id,
    proposalId: entry.proposalId,
    author: proposal?.author ?? "",
    date: proposal?.date ?? "",
    label: proposal?.label ?? "",
    sheet: entry.sheet,
    kind: entry.kind,
    stale,
  };
  const empty = { oldValue: null, newValue: null, oldFormula: null, newFormula: null, oldStyleId: 0, newStyleId: 0, count: 1 };
  switch (entry.kind) {
    case "cell": {
      const cell = stale ? null : ctx.workbook.getCell(entry.sheet, { row: entry.row, col: entry.col });
      return {
        ...base,
        row: entry.row,
        col: entry.col,
        oldValue: copyValue(entry.old.value),
        newValue: cell === null ? copyValue(entry.next.value) : cell.value,
        oldFormula: entry.old.formula,
        newFormula: entry.next.formula,
        oldStyleId: entry.old.styleId,
        newStyleId: entry.next.styleId,
        oldDisplay: display(ctx, entry.old.value, entry.old.styleId),
        newDisplay: cell === null ? display(ctx, entry.next.value, entry.next.styleId) : cell.display,
        count: 1,
        summary: "Edit cell",
      };
    }
    case "addSheet":
      return { ...base, ...empty, row: 0, col: 0, oldDisplay: "", newDisplay: entry.name, summary: `Add sheet ${entry.name}` };
    case "renameSheet":
      return {
        ...base,
        ...empty,
        row: 0,
        col: 0,
        oldDisplay: entry.oldName,
        newDisplay: entry.newName,
        summary: `Rename sheet ${entry.oldName} to ${entry.newName}`,
      };
    default: {
      const rows = entry.kind === "insertRows" || entry.kind === "deleteRows";
      return {
        ...base,
        ...empty,
        row: rows ? entry.index : 0,
        col: rows ? 0 : entry.index,
        count: entry.count,
        oldDisplay: "",
        newDisplay: "",
        summary: axisSummary(entry),
      };
    }
  }
}

/** Pending changes by sheet tab order, row, column, then recording order. */
export function listChanges(ctx: JournalContext): JournalChange[] {
  const order = new Map(ctx.workbook.listSheets().map((sheet) => [sheet.id, sheet.index]));
  const entries = ctx.store.ordered();
  entries.sort((a, b) => {
    const sa = order.get(a.sheet) ?? Number.MAX_SAFE_INTEGER;
    const sb = order.get(b.sheet) ?? Number.MAX_SAFE_INTEGER;
    if (sa !== sb) return sa - sb;
    const ra = a.kind === "cell" ? a.row : -1;
    const rb = b.kind === "cell" ? b.row : -1;
    if (ra !== rb) return ra - rb;
    const ca = a.kind === "cell" ? a.col : -1;
    const cb = b.kind === "cell" ? b.col : -1;
    return ca !== cb ? ca - cb : a.seq - b.seq;
  });
  return entries.map((entry) => viewOf(ctx, entry));
}

/** Proposals with pending changes, oldest first. */
export function listProposals(ctx: JournalContext): Proposal[] {
  const counts = new Map<string, number>();
  for (const entry of ctx.store.entries.values()) counts.set(entry.proposalId, (counts.get(entry.proposalId) ?? 0) + 1);
  return [...ctx.store.proposals.values()]
    .filter((proposal) => (counts.get(proposal.id) ?? 0) > 0)
    .sort((a, b) => a.seq - b.seq)
    .map((proposal) => ({
      id: proposal.id,
      author: proposal.author,
      date: proposal.date,
      label: proposal.label,
      pendingCount: counts.get(proposal.id) ?? 0,
    }));
}
