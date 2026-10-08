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

/** One page of conflicts; the gateway's BRAIN_CONFLICTS_MAX_LIMIT. */
export const BRAIN_CONFLICTS_LIMIT = 50;
/** Conflicts a claims screen reads in all, page by page (the 500-item list limit). */
export const BRAIN_CONFLICTS_MAX = 500;
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
  return `Background model work (claims, all projects): ${brainUsdText(spend.remainingMicroUsd)} of `
    + `${brainUsdText(spend.capMicroUsd)} USD left for the last 30 days.`;
}

/** The model spend on its own, across all of the owner's projects; "" without a budget. */
export function brainModelSpendText(spend: BrainModelSpend | null): string {
  if (spend === null) return "";
  return `Background model work in the last 30 days, all projects: ${brainUsdText(spend.spentMicroUsd)} of `
    + `${brainUsdText(spend.capMicroUsd)} USD. Chat answers are billed like any Chat.`;
}

/** How long ago, short: "now", "5m", "3h", "2d", then the day. */
export function brainAgo(iso: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 7 * 24 * 60) return `${Math.floor(minutes / (24 * 60))}d`;
  return brainDay(iso);
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
  for (const conflict of state.data.items.slice(0, BRAIN_CONFLICTS_MAX)) {
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

export interface BrainTypedSourceInput {
  readonly label: string; readonly example: string; readonly hint: string; readonly pattern: RegExp;
  /** How one typed value is written before the pattern check (a tag lowercased, a team key uppercased). */
  readonly normalize?: (value: string) => string;
}
/** Kinds typed when they list no options (Linear, Drive and Calendar list none yet); the gateway checks them again. */
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
    pattern: /^[a-z][a-z0-9-]{1,40}$/, normalize: (value) => value.replace(/^#/, "").toLowerCase(),
  },
  // The gateway's LinearConfigSchema, GoogleDriveConfigSchema and GoogleCalendarConfigSchema item patterns.
  linear: {
    label: "Team keys", example: "ENG, DESIGN", hint: "The key in each team's issue ids (ENG-123).",
    pattern: /^[A-Z][A-Z0-9]{0,9}$/, normalize: (value) => value.toUpperCase(),
  },
  google_drive: {
    label: "Folder ids", example: "1aBcD2eFgH3iJkL4mNoP5qRsT6uVwXyZ7",
    hint: "The part after /folders/ in each folder's link.", pattern: /^[A-Za-z0-9_-]{1,256}$/,
  },
  google_calendar: {
    label: "Calendar ids", example: "primary",
    hint: "primary is your own calendar; another calendar shows its id in its settings.",
    pattern: /^(?!\.{1,2}$)[^\s\p{Cc}]{1,256}$/u,
  },
};

/**
 * What the owner typed for a kind: one value, or for a kind that takes several, values split on commas or spaces,
 * each normalized and de-duplicated. Empty when nothing was typed; null when a value is not valid.
 */
export function brainTypedValues(kind: BrainConnectableSourceKind, text: string): readonly string[] | null {
  const input = BRAIN_TYPED_SOURCE_INPUTS[kind];
  const typed = BRAIN_SOURCE_CHOICES_MAX[kind] > 1 ? text.split(/[\s,]+/) : [text.trim()];
  const values = typed.map((value) => input?.normalize?.(value) ?? value).filter((value) => value !== "");
  if (input === undefined) return values.length === 0 ? [] : null;
  return values.every((value) => input.pattern.test(value)) ? [...new Set(values)] : null;
}

/** Per-kind settings of the connect form; a kind reads only its own fields. A missing include key is on. */
export interface BrainSourceSettings {
  readonly include: Readonly<Record<string, boolean>>; readonly extensions: string; readonly maxFileBytes: number;
  readonly pastDays: number; readonly futureDays: number;
}
export const BRAIN_SOURCE_DEFAULT_SETTINGS: BrainSourceSettings = {
  include: {}, extensions: "md, txt", maxFileBytes: 262_144, pastDays: 14, futureDays: 14,
};
/** What a GitHub or Linear source reads; at least one stays on. */
export const BRAIN_SOURCE_INCLUDE: Partial<Record<BrainConnectableSourceKind, readonly (readonly [string, string])[]>> = {
  github: [["pullRequests", "Pull requests"], ["reviews", "Reviews"], ["issues", "Issues"]],
  linear: [["issues", "Issues"], ["comments", "Comments"], ["projectUpdates", "Project updates"]],
};
/** An item type read only with another: a GitHub review belongs to a pull request, and the gateway refuses it alone. */
const BRAIN_SOURCE_INCLUDE_NEEDS: Partial<Record<BrainConnectableSourceKind, Readonly<Record<string, string>>>> = {
  github: { reviews: "pullRequests" },
};
/** Whether a kind reads an item type: on unless switched off, and off while the type it needs is off. */
export function brainIncludeOn(kind: BrainConnectableSourceKind, settings: BrainSourceSettings, key: string): boolean {
  const need = BRAIN_SOURCE_INCLUDE_NEEDS[kind]?.[key];
  return (settings.include[key] ?? true) && (need === undefined || brainIncludeOn(kind, settings, need));
}
/** The item type `key` is read only with (pull requests for GitHub reviews), or undefined. */
export function brainIncludeNeed(kind: BrainConnectableSourceKind, key: string): string | undefined {
  return BRAIN_SOURCE_INCLUDE_NEEDS[kind]?.[key];
}
/** Matrix files size choices, up to the gateway ceiling (1 MiB). */
export const BRAIN_FILE_SIZE_CHOICES = [[65_536, "64 KiB"], [262_144, "256 KiB"], [1_048_576, "1 MiB"]] as const;
/** The gateway's calendar window bound, each way. */
export const BRAIN_CALENDAR_DAYS_MAX = 90;
const EXTENSIONS_MAX = 32;

/** File endings typed as "md, .txt": lowercased, de-duplicated; null unless 1 to 32 valid endings. */
export function brainExtensions(text: string): readonly string[] | null {
  const values = [...new Set(text.split(/[\s,]+/).map((value) => value.replace(/^\./, "").toLowerCase())
    .filter((value) => value !== ""))];
  return values.length > 0 && values.length <= EXTENSIONS_MAX && values.every((value) => /^[a-z0-9]{1,16}$/.test(value))
    ? values : null;
}

const validDays = (days: number) => Number.isInteger(days) && days >= 0 && days <= BRAIN_CALENDAR_DAYS_MAX;

/** Null when a kind's settings can be sent; else what to fix. */
export function brainSourceSettingsProblem(kind: BrainConnectableSourceKind, settings: BrainSourceSettings): string | null {
  const include = BRAIN_SOURCE_INCLUDE[kind];
  if (include !== undefined && !include.some(([key]) => brainIncludeOn(kind, settings, key))) return "Pick at least one.";
  if (kind === "matrix_files" && brainExtensions(settings.extensions) === null) return "List 1 to 32 file endings.";
  if (kind === "google_calendar" && !(validDays(settings.pastDays) && validDays(settings.futureDays))) {
    return `Days run from 0 to ${BRAIN_CALENDAR_DAYS_MAX}.`;
  }
  return null;
}

/**
 * The config a kind's handler expects, from the chosen option ids, typed values and the kind's settings. The gateway
 * validates it (source_config_invalid). Defaults: every GitHub and Linear item type, Markdown and text files up to
 * 256 KiB, calendar 14 days each way without event bodies. Matrix notes with no tags read every note.
 */
export function brainSourceConfig(kind: BrainConnectableSourceKind, ids: readonly string[],
  settings: BrainSourceSettings = BRAIN_SOURCE_DEFAULT_SETTINGS): unknown {
  const on = (key: string) => brainIncludeOn(kind, settings, key);
  switch (kind) {
    case "github": return {
      repo: ids[0], mode: "integration", include: { pullRequests: on("pullRequests"), reviews: on("reviews"), issues: on("issues") },
    };
    case "matrix_notes": return { folders: ids };
    case "matrix_files": return {
      roots: ids, extensions: brainExtensions(settings.extensions) ?? ["md", "txt"], maxFileBytes: settings.maxFileBytes,
    };
    case "matrix_chat": return { chatIds: ids };
    case "linear": return {
      teamKeys: ids, include: { issues: on("issues"), comments: on("comments"), projectUpdates: on("projectUpdates") },
    };
    case "google_drive": return { folderIds: ids };
    case "google_calendar": return {
      calendarIds: ids, includeEventBodies: false, pastDays: settings.pastDays, futureDays: settings.futureDays,
    };
    case "slack_bridge": return { companyScopeId: ids[0], channelIds: [] };
  }
}

export function brainCountsText(counts: BrainSyncCounts): string {
  return `${counts.written} written, ${counts.unchanged} unchanged, ${counts.deleted} removed, ${counts.failed} failed`;
}

/** One line about a finished sync run (git or another source). */
export function brainSyncText(view: BrainSyncView | BrainSourceSyncView): string {
  const next = brainNextActionText(view.nextAction);
  const head = view.status === "failed" ? "Sync failed." : `Synced: ${brainCountsText(view.counts)}.`;
  return next === "" ? head : `${head} ${next}`;
}

/** One line about a finished claim reading run. */
export function brainExtractText(view: BrainExtractView): string {
  const next = brainNextActionText(view.nextAction);
  const head = view.status === "failed"
    ? "Finding claims failed."
    : `Read ${view.counts.documentsProcessed} documents and found ${view.counts.claimsWritten} claims.`;
  return next === "" ? head : `${head} ${next}`;
}

/** The entity ref a typed value names: `file:`, `folder:` (trailing "/") or `spec:` (with the "specs/" prefix). */
export function brainTimelineRef(kind: "file" | "spec", value: string): string {
  if (kind === "spec") return `spec:${value.startsWith("specs/") ? value : `specs/${value}`}`;
  return value.endsWith("/") ? `folder:${value.replace(/\/+$/, "")}` : `file:${value}`;
}

/** One line about a background run: where it is, and what to do next once it ended. */
export function brainJobText(label: string, view: BrainJobView): string {
  const steps = view.steps === null ? "" : `, ${view.steps} ${view.steps === 1 ? "step" : "steps"} done`;
  const failed = view.errorCode === null ? "" : ` ${BRAIN_JOB_CODE_COPY[view.errorCode]}`;
  const running = view.waiting === true ? `${label}: waiting for another run of this project to finish${steps}.`
    : `${label}: running${steps}.`;
  const head = {
    queued: `${label}: waiting to start.`, running, succeeded: `${label}: done${steps}.`,
    failed: `${label}: failed.${failed}`, cancelled: `${label}: stopped.`,
  }[view.status];
  const next = brainNextActionText(view.nextAction);
  return next === "" ? head : `${head} ${next}`;
}

/**
 * The repo path a question names, or null for words: no spaces and a "/" or a file ending (`why.ts`). A leading "./"
 * is dropped; a leading "/", an empty segment, "." or ".." is not a repo path (the why route refuses them), so those
 * and links are left to search. A trailing "/" (the folder only) is kept.
 */
export function brainAskPath(text: string): string | null {
  const path = text.replace(/^(?:\.\/)+/, "");
  if (/\s/.test(path) || path.includes("://")) return null;
  if (!path.includes("/") && !/\.[A-Za-z][A-Za-z0-9]{0,15}$/.test(path)) return null;
  const segments = (path.endsWith("/") ? path.slice(0, -1) : path).split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..") ? path : null;
}

/** "87% likely" from a 0..1 score. */
export function brainScoreText(score: number): string {
  return `${Math.round(Math.min(1, Math.max(0, score)) * 100)}% likely`;
}

const MERGE_DETAIL_MAX_CHARS = 200;
/** One merge reason in fixed words around the login, name or email part it is about. */
export function brainMergeEvidenceText(evidence: BrainMergeEvidenceView): string {
  const detail = `"${evidence.detail.slice(0, MERGE_DETAIL_MAX_CHARS)}"`;
  switch (evidence.signal) {
    case "same_github_login": return `Same GitHub login ${detail}`;
    case "name_matches_login": return `Name matches the GitHub login ${detail}`;
    case "name_matches_email": return `Name matches the email ${detail}`;
    case "name_seen_with_email": return evidence.documents === null
      ? `Name ${detail} was seen with this email`
      : `Name ${detail} was seen with this email in ${evidence.documents} documents`;
    case "shared_name": return `Both go by ${detail}`;
    default: return `Also seen as ${detail}`;
  }
}
