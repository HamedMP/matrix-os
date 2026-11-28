/** Assistant result cards and how a proposal's card follows the journal after review. */

import type { Finding } from "./checks";
import { type SheetId, type Workbook, isOfficeError } from "./engine";

export type AssistantResultStatus = "proposed" | "accepted" | "rejected";

interface ResultBase {
  id: string;
  title: string;
  summary: string;
}

/** Changes waiting for review. `status` follows the journal: accepted or rejected once none is pending. */
export interface ProposalResult extends ResultBase {
  kind: "proposal";
  status: AssistantResultStatus;
  proposalId: string;
  changeCount: number;
  /** Pending changes left in the journal. */
  pending: number;
  /** What the first changes wrote, to tell accept from reject when they are resolved elsewhere. */
  expected: ExpectedContent[];
}

/** A plain-language answer, with the cells it is about highlighted. */
export interface AnswerResult extends ResultBase {
  kind: "answer";
  subject: string;
  text: string;
}

/** Findings of the integrity checks, and what the run could not look at. */
export interface FindingsResult extends ResultBase {
  kind: "findings";
  findings: Finding[];
  /** Names of the sheets too large to check; when there are any, the check is incomplete. */
  skipped: string[];
  /** True when the run stopped at the most findings it reports. */
  capped: boolean;
}

export type AssistantResult = ProposalResult | AnswerResult | FindingsResult;

export interface ExpectedContent {
  sheet: SheetId;
  row: number;
  col: number;
  formula: string | null;
  value: unknown;
  styleId: number;
}

const MAX_EXPECTED = 50;

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return typeof a === "object" && a !== null && typeof b === "object" && b !== null && (a as { code?: unknown }).code === (b as { code?: unknown }).code;
}

/** The new content of a proposal's first changes, read from the journal right after it was made. */
export function snapshotProposal(workbook: Workbook, proposalId: string): ExpectedContent[] {
  const out: ExpectedContent[] = [];
  for (const change of workbook.listChanges()) {
    if (change.proposalId !== proposalId) continue;
    out.push({ sheet: change.sheet, row: change.row, col: change.col, formula: change.newFormula, value: change.newValue, styleId: change.newStyleId });
    if (out.length >= MAX_EXPECTED) break;
  }
  return out;
}

/** Pending changes of a proposal still in the journal. */
export function pendingOf(workbook: Workbook, proposalId: string): string[] {
  return workbook
    .listChanges()
    .filter((change) => change.proposalId === proposalId)
    .map((change) => change.id);
}

/** For a proposal with nothing pending: accepted when most of its cells still hold what it wrote. */
export function resolvedStatus(workbook: Workbook, expected: readonly ExpectedContent[]): "accepted" | "rejected" {
  if (expected.length === 0) return "accepted";
  let kept = 0;
  for (const entry of expected) {
    try {
      const cell = workbook.getCell(entry.sheet, { row: entry.row, col: entry.col });
      const same = entry.formula !== null ? cell.formula === entry.formula : cell.formula === null && sameValue(cell.value, entry.value);
      if (same && cell.styleId === entry.styleId) kept += 1;
    } catch (error: unknown) {
      // The sheet is gone: that change did not stay.
      if (!isOfficeError(error)) throw error;
    }
  }
  return kept * 2 >= expected.length ? "accepted" : "rejected";
}
