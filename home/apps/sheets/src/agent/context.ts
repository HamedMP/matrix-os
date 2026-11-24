/** What every assistant operation receives and returns. */

import type { SheetsAi } from "./ai";
import type { AgentSession } from "./apply";
import type { CellRange, SheetCellRef, SheetId } from "./engine";

export interface AgentContext {
  session: AgentSession;
  /** The model, or null when this host has none (AI operations then fail with `unavailable`). */
  ai: SheetsAi | null;
  /** Proposal dates. Default the current time. */
  now?: () => Date;
  signal?: AbortSignal;
  log?: (message: string, error: unknown) => void;
}

/** A selection on one sheet. */
export interface SheetSelection {
  sheet: SheetId;
  range: CellRange;
}

export type ProposalOutcome =
  /** Changes were recorded in one proposal and wait for review. */
  | { status: "proposed"; proposalId: string; changeIds: string[]; label: string; summary: string }
  /** The request was understood and nothing needs to change. */
  | { status: "no_changes"; summary: string }
  /** The reply was not usable; nothing was applied. */
  | { status: "invalid"; messages: string[] };

export interface ExplainOutcome {
  /** Plain text from the model, cleaned and bounded. */
  text: string;
  /** What was explained, e.g. `Summary!B4`. */
  subject: string;
  /** Cells to highlight on the grid as sources. */
  highlights: SheetCellRef[];
}

export function isoNow(ctx: AgentContext): string {
  return (ctx.now?.() ?? new Date()).toISOString();
}
