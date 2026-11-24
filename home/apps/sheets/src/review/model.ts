/**
 * Change review data: the engine's change journal grouped by proposal, the
 * order the owner steps through it, and the markup decorations for the grid.
 * Pure functions over a workbook; nothing here changes it.
 */

import type { CellDecoration } from "../grid";
import { type JournalChange, type JournalChangeKind, type SheetId, type Workbook, formatA1, isOfficeError, listJournalChanges } from "./engine";

/** One pending change as the review list shows it. */
export interface ReviewItem {
  id: string;
  proposalId: string;
  kind: JournalChangeKind;
  sheet: SheetId;
  sheetName: string;
  row: number;
  col: number;
  /** A1 address of the cell, or "" for a change of a whole sheet, rows or columns. */
  address: string;
  /** `Sheet!A1`, or the sheet name alone for a sheet-level change. */
  location: string;
  oldDisplay: string;
  newDisplay: string;
  /** Formula text without `=`, or null for a literal. */
  oldFormula: string | null;
  newFormula: string | null;
  /** True when only the cell's format changed. */
  formatOnly: boolean;
  /** One line from the engine, e.g. `Insert rows 2-3`. */
  summary: string;
  /** The cell was changed outside the journal: rejecting cannot restore it. */
  stale: boolean;
  author: string;
  date: string;
  label: string;
}

/** The changes of one proposal, in sheet order. */
export interface ReviewGroup {
  proposalId: string;
  author: string;
  date: string;
  label: string;
  items: ReviewItem[];
}

function sheetName(workbook: Workbook, sheet: SheetId, names: Map<SheetId, string>): string {
  const known = names.get(sheet);
  if (known !== undefined) return known;
  try {
    return workbook.getSheet(sheet).name;
  } catch (error: unknown) {
    if (!isOfficeError(error)) throw error;
    return "";
  }
}

function addressOf(change: JournalChange): string {
  if (change.kind !== "cell") return "";
  return formatA1({ row: change.row, col: change.col });
}

function toItem(change: JournalChange, name: string): ReviewItem {
  const address = addressOf(change);
  const sheetLabel = name === "" && change.kind === "addSheet" ? change.newDisplay : name;
  return {
    id: change.id,
    proposalId: change.proposalId,
    kind: change.kind,
    sheet: change.sheet,
    sheetName: sheetLabel,
    row: change.row,
    col: change.col,
    address,
    location: address === "" ? sheetLabel : `${sheetLabel}!${address}`,
    oldDisplay: change.oldDisplay,
    newDisplay: change.newDisplay,
    oldFormula: change.oldFormula,
    newFormula: change.newFormula,
    formatOnly:
      change.kind === "cell" &&
      change.oldFormula === change.newFormula &&
      sameValue(change.oldValue, change.newValue) &&
      change.oldStyleId !== change.newStyleId,
    summary: change.summary,
    stale: change.stale,
    author: change.author,
    date: change.date,
    label: change.label,
  };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    return (a as { code?: unknown }).code === (b as { code?: unknown }).code;
  }
  return false;
}

/** Pending changes grouped by proposal, oldest proposal first; within a group by sheet tab, row and column. */
export function buildReviewGroups(workbook: Workbook): ReviewGroup[] {
  const changes = listJournalChanges(workbook);
  if (changes.length === 0) return [];
  const names = new Map<SheetId, string>();
  const tabIndex = new Map<SheetId, number>();
  for (const sheet of workbook.listSheets()) {
    names.set(sheet.id, sheet.name);
    tabIndex.set(sheet.id, sheet.index);
  }
  const proposalOrder = new Map<string, number>();
  workbook.listProposals().forEach((proposal, index) => proposalOrder.set(proposal.id, index));

  const groups = new Map<string, ReviewGroup>();
  for (const change of changes) {
    let group = groups.get(change.proposalId);
    if (group === undefined) {
      group = { proposalId: change.proposalId, author: change.author, date: change.date, label: change.label, items: [] };
      groups.set(change.proposalId, group);
    }
    group.items.push(toItem(change, sheetName(workbook, change.sheet, names)));
  }
  const tab = (sheet: SheetId): number => tabIndex.get(sheet) ?? Number.MAX_SAFE_INTEGER;
  for (const group of groups.values()) {
    group.items.sort((a, b) => tab(a.sheet) - tab(b.sheet) || a.row - b.row || a.col - b.col);
  }
  const rank = (id: string): number => proposalOrder.get(id) ?? Number.MAX_SAFE_INTEGER;
  return [...groups.values()].sort((a, b) => rank(a.proposalId) - rank(b.proposalId));
}

/** Every change in the order the owner steps through them. */
export function reviewOrder(groups: readonly ReviewGroup[]): ReviewItem[] {
  return groups.flatMap((group) => group.items);
}

/** The text a markup view strikes through: the old display, or "empty". */
export function markupOldText(item: ReviewItem): string {
  return item.oldDisplay === "" ? "empty" : item.oldDisplay;
}

/** `proposed` decorations for the grid: one per changed cell, with the old and new text. */
export function markupDecorations(items: readonly ReviewItem[]): CellDecoration[] {
  const out: CellDecoration[] = [];
  for (const item of items) {
    if (item.kind !== "cell") continue;
    out.push({
      sheet: item.sheet,
      row: item.row,
      col: item.col,
      kind: "proposed",
      oldValue: item.oldDisplay,
      newValue: item.newDisplay,
      changeId: item.id,
      label: `${item.author}: ${item.label}`,
    });
  }
  return out;
}

/** Change id to the struck-through old text, for the markup overlay. */
export function markupOldTextById(items: readonly ReviewItem[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const item of items) if (item.kind === "cell" && !item.formatOnly) out.set(item.id, markupOldText(item));
  return out;
}
