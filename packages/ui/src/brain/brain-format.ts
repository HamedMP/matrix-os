/**
 * Pure helpers of the Company Brain view: wording of errors and run results, refs, configs and flags. Kept apart from
 * the components so every component file exports components only.
 */
import {
  BRAIN_ERROR_COPY, BRAIN_JOB_CODE_COPY, BRAIN_NOT_CONNECTED_CODES, type BrainConflictsView,
  type BrainConnectableSourceKind, type BrainExtractView, type BrainJobView, type BrainMergeEvidenceView,
  type BrainModelSpend,
  type BrainShellErrorState, type BrainSourceKind, type BrainSourceSyncView, type BrainSyncCounts, type BrainSyncView,
} from "./brain-types.js";
import type { BrainLoad } from "./use-brain-load.js";

/** Conflicts read once per claims screen; the gateway's BRAIN_CONFLICTS_MAX_LIMIT. */
export const BRAIN_CONFLICTS_LIMIT = 50;
/** Recent syncs a source card reads and shows. */
export const BRAIN_RECEIPTS_SHOWN = 5;

export function brainErrorText(error: BrainShellErrorState): string {
  switch (error.kind) {
    case "unauthorized": return "You do not have access to this project's brain. Sign in again or ask the owner.";
    case "offline": return "Can't reach Matrix OS. Check your connection.";
    case "timeout": return "That took too long. Try again.";
    case "unavailable": return "The Company Brain is off right now. Try again later.";
    default: return BRAIN_ERROR_COPY[error.code] ?? "This part of the Company Brain is not turned on yet.";
  }
}

export function isBrainNotConnected(error: BrainShellErrorState): boolean {
  return error.kind === "rejected" && (BRAIN_NOT_CONNECTED_CODES as readonly string[]).includes(error.code);
}

const NEXT_ACTION_TEXT: Readonly<Record<string, string>> = {
  run_again: "There is more to read; run it again.",
  retry_later: "Try again later.",
  fix_source: "Check the source settings.",
  connect_account: "Connect the account in Settings.",
  raise_capacity: "The project brain is full.",
  configure_model: "Set up a claim reading model first.",
  raise_budget: "The model spend limit for the last 30 days is used up.",
  contact_support: "Contact support if this keeps happening.",
};
export function brainNextActionText(nextAction: string): string {
  return NEXT_ACTION_TEXT[nextAction] ?? "";
}

/** "1.25" from micro-USD, rounded down to the cent so a budget is never shown larger than it is. */
export function brainUsdText(microUsd: number): string {
  const cents = Math.floor(Math.max(0, microUsd) / 10_000);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** One line about the project's model budget, or "" without one (the gateway has no model settings). */
export function brainModelBudgetText(spend: BrainModelSpend | null): string {
  if (spend === null) return "";
  return `Model budget (per owner, all projects): ${brainUsdText(spend.remainingMicroUsd)} of `
    + `${brainUsdText(spend.capMicroUsd)} USD left for the last 30 days.`;
}

/** The model spend on its own, across all of the owner's projects; "" without a budget. */
export function brainModelSpendText(spend: BrainModelSpend | null): string {
  if (spend === null) return "";
  return `Model spend in the last 30 days, all projects: ${brainUsdText(spend.spentMicroUsd)} of `
    + `${brainUsdText(spend.capMicroUsd)} USD.`;
}

/** "2026-10-02" from an ISO instant; the brain stores UTC dates. */
export function brainDay(iso: string): string {
  return iso.slice(0, 10);
}

/** Arrow keys move between tabs (both axes, wrapping); Home and End jump to the ends. */
export function brainTabIndexForKey(key: string, index: number, count: number): number | null {
  if (key === "ArrowRight" || key === "ArrowDown") return (index + 1) % count;
  if (key === "ArrowLeft" || key === "ArrowUp") return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

/** Claim id -> the summary of a conflict it is part of (both sides of every conflict). */
export function brainConflictFlags(state: BrainLoad<BrainConflictsView>): ReadonlyMap<string, string> {
  const flags = new Map<string, string>();
  if (state.status !== "ready") return flags;
  for (const conflict of state.data.items.slice(0, BRAIN_CONFLICTS_LIMIT)) {
    for (const side of conflict.sides) {
      if (side.claimId !== null) flags.set(side.claimId, conflict.summary);
    }
  }
  return flags;
}

export const BRAIN_SOURCE_KIND_LABELS: Readonly<Record<BrainSourceKind, string>> = {
  git: "Git repository", github: "GitHub", matrix_notes: "Matrix notes", matrix_files: "Matrix files",
  matrix_chat: "Matrix chats", linear: "Linear", google_drive: "Google Drive", google_calendar: "Google Calendar",
  slack_bridge: "Slack",
};

/** The most one config can name per kind (gateway BRAIN_SOURCE_CONFIG_LIMITS and BRAIN_MATRIX_LIMITS.noteFolders). */
export const BRAIN_SOURCE_CHOICES_MAX: Readonly<Record<BrainConnectableSourceKind, number>> = {
  github: 1, slack_bridge: 1, matrix_files: 8, google_calendar: 10, linear: 20, google_drive: 20, matrix_notes: 20,
  matrix_chat: 50,
};

export interface BrainTypedSourceInput { readonly label: string; readonly example: string; readonly hint: string; readonly pattern: RegExp }
/** Kinds whose handler may list no options: the owner types the value instead, and the gateway checks it again. */
export const BRAIN_TYPED_SOURCE_INPUTS: Partial<Record<BrainConnectableSourceKind, BrainTypedSourceInput>> = {
  github: {
    label: "Repository (owner/name)", example: "owner/name", hint: "The GitHub repository of this project.",
    pattern: /^(?!\.\.?\/)[A-Za-z0-9_.-]{1,100}\/(?!\.\.?$)[A-Za-z0-9_.-]{1,100}$/,
  },
  slack_bridge: {
    label: "Company Brain scope id", example: "00000000-0000-0000-0000-000000000000",
    hint: "The Company Brain whose captured Slack threads are read.",
    pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  },
  matrix_notes: {
    label: "Tags (optional)", example: "design, roadmap", hint: "Leave empty to include every note.",
    pattern: /^[a-z][a-z0-9-]{1,40}$/,
  },
};

/**
 * What the owner typed for a kind: one value, or for Matrix notes tags split on commas or spaces (a leading "#"
 * dropped, lowercased, de-duplicated). Empty when nothing was typed; null when a value is not valid.
 */
export function brainTypedValues(kind: BrainConnectableSourceKind, text: string): readonly string[] | null {
  const input = BRAIN_TYPED_SOURCE_INPUTS[kind];
  const values = kind === "matrix_notes"
    ? text.split(/[\s,]+/).map((value) => value.replace(/^#/, "").toLowerCase()).filter((value) => value !== "")
    : [text.trim()].filter((value) => value !== "");
  if (input === undefined) return values.length === 0 ? [] : null;
  return values.every((value) => input.pattern.test(value)) ? [...new Set(values)] : null;
}
