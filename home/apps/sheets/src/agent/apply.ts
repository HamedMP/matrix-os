/**
 * From a model reply to a reviewable proposal.
 *
 * `validateReply` reads the reply with the engine's `parseAgentEdits`,
 * resolves it against the live workbook with `toSheetEdits`, and checks it
 * against the scope the operation allows. Any problem rejects the whole
 * reply: nothing is applied unless every edit is valid.
 *
 * `runProposal` makes changes inside one journal proposal authored by the
 * Matrix Assistant, so the owner can review, accept or reject each of them.
 */

import type { SessionEvent } from "../session";
import {
  type CellRange,
  type ProposalOptions,
  type ResolvedSheetEdit,
  type SheetId,
  type Workbook,
  isOfficeError,
  parseAgentEdits,
  toSheetEdits,
} from "./engine";
import { SheetsAgentError } from "./ai";
import { ASSISTANT_AUTHOR, MAX_PROPOSED_CELLS } from "./limits";
import { oneLine } from "./untrusted";

/** The parts of `SheetSession` the assistant uses. */
export interface AgentSession {
  readonly workbook: Workbook;
  mutate<T>(run: (workbook: Workbook) => T): T;
  acceptChanges(ids: readonly string[] | "all"): unknown;
  rejectChanges(ids: readonly string[] | "all"): unknown;
  subscribe(listener: (event: SessionEvent) => void): () => void;
}

/** Where an operation may write. */
export interface EditScope {
  /** Only this sheet. */
  sheet?: SheetId;
  /** Only inside this range (of `sheet`). */
  range?: CellRange;
  /**
   * Cells that already hold something may change only inside this range;
   * outside it the edit may fill empty cells only. `null` protects every
   * non-empty cell. Leave out to allow changing any cell.
   */
  editable?: CellRange | null;
}

export type ValidationResult =
  | { ok: true; edits: ResolvedSheetEdit[]; summary: string }
  | { ok: false; reason: "unreadable" | "empty" | "rejected" | "too_many" | "out_of_scope"; messages: string[] };

const REJECTED_WORDS: Record<string, string> = {
  not_found: "names a sheet that does not exist",
  stale_reference: "was made for content that has changed since",
  ambiguous: "is ambiguous",
  invalid_operation: "cannot be applied there (a bad address, a formula that does not parse, or part of an array formula)",
};

const PARSE_WORDS: Record<string, string> = {
  no_json: "The assistant did not answer with changes.",
  invalid_json: "The assistant's answer could not be read.",
  invalid_shape: "The assistant's answer was not in the expected form.",
  wrong_kind: "The assistant answered for another kind of document.",
  too_large: "The assistant's answer was too large.",
};

function inside(range: CellRange, row: number, col: number): boolean {
  return row >= range.start.row && row <= range.end.row && col >= range.start.col && col <= range.end.col;
}

/** Checks a model reply against the live workbook and the scope. Never changes the workbook. */
export function validateReply(workbook: Workbook, reply: string, scope: EditScope = {}): ValidationResult {
  const parsed = parseAgentEdits(reply, "sheet");
  if (!parsed.ok) return { ok: false, reason: "unreadable", messages: [PARSE_WORDS[parsed.error.code] ?? PARSE_WORDS.invalid_shape!] };
  const envelope = parsed.envelope;
  const summary = oneLine(envelope.summary ?? "", 300);
  if (envelope.kind !== "sheet" || envelope.edits.length === 0) return { ok: false, reason: "empty", messages: [summary === "" ? "The assistant proposed no changes." : summary] };
  const plan = toSheetEdits(workbook, envelope.edits);
  if (plan.rejected.length > 0) {
    const messages = plan.rejected.slice(0, 10).map((entry) => `Change ${entry.index + 1} ${REJECTED_WORDS[entry.code] ?? "is not valid"}.`);
    if (plan.rejected.length > 10) messages.push(`${plan.rejected.length - 10} more changes were not valid.`);
    return { ok: false, reason: "rejected", messages };
  }
  if (plan.edits.length > MAX_PROPOSED_CELLS) {
    return { ok: false, reason: "too_many", messages: [`The assistant proposed ${plan.edits.length} cell changes; at most ${MAX_PROPOSED_CELLS} are allowed at once.`] };
  }
  const outside = new Set<number>();
  for (const edit of plan.edits) {
    if (scope.sheet !== undefined && edit.sheet !== scope.sheet) outside.add(edit.editIndex);
    else if (scope.range !== undefined && !inside(scope.range, edit.row, edit.col)) outside.add(edit.editIndex);
    else if (scope.editable !== undefined && (scope.editable === null || !inside(scope.editable, edit.row, edit.col))) {
      const cell = workbook.getCell(edit.sheet, { row: edit.row, col: edit.col });
      if (cell.value !== null || cell.formula !== null) outside.add(edit.editIndex);
    }
  }
  if (outside.size > 0) {
    const indexes = [...outside].sort((a, b) => a - b).slice(0, 10).map((index) => index + 1);
    return { ok: false, reason: "out_of_scope", messages: [`Change${indexes.length === 1 ? "" : "s"} ${indexes.join(", ")} would write outside the cells this action may change.`] };
  }
  return { ok: true, edits: plan.edits, summary };
}

/** Writes one resolved edit. */
export function writeResolved(workbook: Workbook, edit: ResolvedSheetEdit): void {
  const address = { row: edit.row, col: edit.col };
  if (edit.formula !== null) workbook.setFormula(edit.sheet, address, edit.formula);
  else workbook.setCell(edit.sheet, address, edit.value);
}

export interface ProposalRecord {
  proposalId: string;
  changeIds: string[];
}

/**
 * Runs `write` inside a new proposal authored by the Matrix Assistant, then
 * recalculates. All or nothing: when `write` throws, every change it
 * recorded is rejected and {@link SheetsAgentError} `apply_failed` is thrown.
 */
export function runProposal(session: AgentSession, label: string, date: string, write: (workbook: Workbook) => void, log?: (message: string, error: unknown) => void): ProposalRecord {
  const options: ProposalOptions = { author: ASSISTANT_AUTHOR, date, label: oneLine(label, 200) || "Assistant changes" };
  try {
    return session.mutate((workbook) => {
      const proposalId = workbook.beginProposal(options);
      const mine = (): string[] => workbook.listChanges().filter((change) => change.proposalId === proposalId).map((change) => change.id);
      try {
        write(workbook);
      } catch (error: unknown) {
        workbook.endProposal();
        const recorded = mine();
        if (recorded.length > 0) workbook.rejectChanges(recorded);
        throw error;
      }
      workbook.endProposal();
      return { proposalId, changeIds: mine() };
    });
  } catch (error: unknown) {
    if (!isOfficeError(error)) log?.("an assistant proposal failed", error);
    throw new SheetsAgentError("apply_failed");
  }
}
