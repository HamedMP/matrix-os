/**
 * Company Brain feature contract, part 6: the daily brief, conflicts and stale data of one project scope. All
 * deterministic; every line cites at least one document. An optional model-written summary sits behind a flag that
 * is off by default. Types and constants only.
 */
import type { BrainClaimKind, BrainExtractionUsageInput } from "../claims/types.js";
import type { BrainRepository } from "../repository.js";
import type { BrainCiteView, BrainProjectResolver } from "./common.js";
import type { BrainChangeListener, BrainScopeLister } from "./hooks.js";

// Briefs.

/** Days are UTC. day: [date 00:00Z, +1 day). week: the 7 days ending with `date`. */
export type BrainBriefWindow = "day" | "week";

export const BRAIN_BRIEF_LIMITS = {
  linesPerSection: 50, changeGroupsMax: 20, changeItemsPerGroup: 10, lineTextMaxChars: 400, citesPerLine: 4,
  /** Stored briefs kept per scope, newest date first. */
  storedPerScope: 60,
  /** JSON bytes of one stored brief. */
  storedMaxBytes: 262_144,
  summaryMaxChars: 1_200,
  /** Days back a brief date may be (and forward: none beyond today UTC). */
  historyDays: 365,
} as const;

/** text: plain, one line. cites: 1..citesPerLine, the first is the primary source. */
export interface BrainBriefLine {
  readonly lineId: string; readonly text: string; readonly cites: readonly BrainCiteView[];
  readonly claimId: string | null; readonly claimKind: BrainClaimKind | null;
  /**
   * Commitments: a calendar YYYY-MM-DD and assignee from claim fields, else the document's due and assignee refs;
   * null otherwise.
   */
  readonly due: string | null; readonly assignee: string | null;
  /** Risks: claim severity; null otherwise. */
  readonly severity: "low" | "medium" | "high" | null;
}

/** New and revised documents of one source in the window. */
export interface BrainBriefChangeGroup {
  readonly sourceId: string | null; readonly sourceKind: string | null; readonly label: string;
  readonly created: number; readonly revised: number; readonly items: readonly BrainBriefLine[];
}

/**
 * attention: open conflicts, overdue commitments, failing or old sources, outdated claims in the window, each one
 * line. decisions / risks: claims first seen in the window. commitments: every open commitment (not only new).
 */
export interface BrainBriefSections {
  readonly changes: readonly BrainBriefChangeGroup[];
  readonly decisions: readonly BrainBriefLine[];
  readonly commitments: readonly BrainBriefLine[];
  readonly risks: readonly BrainBriefLine[];
  readonly attention: readonly BrainBriefLine[];
}

export interface BrainBriefSummaryView { readonly text: string; readonly modelId: string; readonly generatedAt: string }

/** truncated: a section cap was hit. stored: this brief is the stored copy for (date, window). */
export interface BrainBriefView {
  readonly date: string; readonly window: BrainBriefWindow; readonly from: string; readonly to: string;
  readonly generatedAt: string; readonly sections: BrainBriefSections; readonly summary: BrainBriefSummaryView | null;
  readonly truncated: boolean; readonly stored: boolean;
}

/**
 * date: YYYY-MM-DD, default today UTC. GET returns the stored brief, unless it was built before its window ended and
 * is stale (then, or when none is stored, it builds, stores and returns it).
 */
export interface BrainBriefQuery { readonly date?: string; readonly window?: BrainBriefWindow }
/** Rebuilds and replaces the stored brief. summary: true needs the summary flag and model, else summary_not_configured. */
export interface BrainBriefGenerateInput {
  readonly date?: string; readonly window?: BrainBriefWindow; readonly summary?: boolean;
}
export const BRAIN_BRIEF_BODY_MAX_BYTES = 1_024;

// Conflicts.

/**
 * label_disagreement: two current decision or invariant claims with the same normalized label from different
 * documents (preferring different sources) whose normalized statements contradict (opposite negation or different
 * values on the same words). draft_spec_shipped: a git_spec whose
 * status line reads Draft while a later merged PR references the spec. commitment_reversed: commitment claims with
 * the same normalized label where a newer one marks done what an older one deferred, or the reverse.
 */
export const BRAIN_CONFLICT_RULES = ["label_disagreement", "draft_spec_shipped", "commitment_reversed"] as const;
export type BrainConflictRule = (typeof BRAIN_CONFLICT_RULES)[number];

/** quote: verbatim from the document (a claim quote, or the spec status line), at most 300 UTF-16 units. */
export interface BrainConflictSideView {
  readonly cite: BrainCiteView; readonly claimId: string | null; readonly statement: string | null;
  readonly quote: string;
}

/** conflictId: "cfl_" + 32 hex of sha256([rule, sorted side keys]); stable while both sides are live. */
export interface BrainConflictView {
  readonly conflictId: string; readonly rule: BrainConflictRule; readonly summary: string;
  readonly sides: readonly [BrainConflictSideView, BrainConflictSideView]; readonly detectedAt: string;
}
/** Newest side first; computed on demand from current claims and documents (bounded scans). */
export interface BrainConflictsView { readonly items: readonly BrainConflictView[]; readonly nextCursor: string | null }
export interface BrainConflictsQuery {
  readonly rules?: readonly BrainConflictRule[]; readonly limit?: number; readonly cursor?: string;
}

// Stale data.

/**
 * claim_outdated: a claim whose document moved to another revision since extraction. source_sync_old: no successful
 * receipt for BRAIN_STALE_SOURCE_DAYS. source_failing: the newest receipt failed. commitment_overdue: an open
 * commitment whose due date is before today UTC.
 */
export const BRAIN_STALE_KINDS = ["claim_outdated", "source_sync_old", "source_failing", "commitment_overdue"] as const;
export type BrainStaleKind = (typeof BRAIN_STALE_KINDS)[number];
export const BRAIN_STALE_SOURCE_DAYS = 7;

/** cite: null only for source kinds (sourceId set). since: when it became stale (ISO-8601). */
export interface BrainStaleItemView {
  readonly kind: BrainStaleKind; readonly text: string; readonly since: string;
  readonly cite: BrainCiteView | null; readonly sourceId: string | null; readonly claimId: string | null;
}
export interface BrainStaleView { readonly items: readonly BrainStaleItemView[]; readonly nextCursor: string | null }
export interface BrainStaleQuery { readonly kinds?: readonly BrainStaleKind[]; readonly limit?: number; readonly cursor?: string }
export const BRAIN_CONFLICTS_DEFAULT_LIMIT = 20;
export const BRAIN_CONFLICTS_MAX_LIMIT = 50;

// Summary seam. No implementation in this increment; nothing calls a model unless the flag is on and one is given.

export const BRAIN_BRIEF_SUMMARY_ENV = "MATRIX_BRAIN_BRIEF_SUMMARY";
export interface BrainBriefSummaryModel {
  /**
   * lines: texts of the brief's lines that cite only git documents (no ids, no permalinks); returns plain text of at
   * most summaryMaxChars.
   */
  summarize(input: { readonly date: string; readonly lines: readonly string[] }, signal: AbortSignal): Promise<{
    readonly text: string; readonly modelId: string; readonly usage: BrainExtractionUsageInput;
  }>;
}
/** Resolved per request; null when the flag is off or no model or credential is configured. */
export type BrainBriefSummaryProvider = () => Promise<BrainBriefSummaryModel | null>;

// Service, runner and scheduler.

export interface BrainBriefServiceDeps {
  readonly repository: BrainRepository; readonly resolver: BrainProjectResolver;
  readonly summaries?: BrainBriefSummaryProvider; readonly now?: () => Date;
}

export interface BrainBriefService {
  getBrief(ownerId: string, projectRef: string, query: BrainBriefQuery): Promise<BrainBriefView>;
  generateBrief(ownerId: string, projectRef: string, input: BrainBriefGenerateInput): Promise<BrainBriefView>;
  conflicts(ownerId: string, projectRef: string, query: BrainConflictsQuery): Promise<BrainConflictsView>;
  stale(ownerId: string, projectRef: string, query: BrainStaleQuery): Promise<BrainStaleView>;
}

/** One pass: builds and stores today's day brief for every active scope (up to BRAIN_SCHEDULED_SCOPES_MAX). */
export interface BrainBriefRunSummary {
  readonly scopes: number; readonly built: number; readonly failed: number; readonly skipped: number;
}
export type BrainBriefRunner = (input: {
  readonly ownerId: string; readonly now: Date; readonly scopes: BrainScopeLister; readonly signal: AbortSignal;
}) => Promise<BrainBriefRunSummary>;

/** The scheduler runs the runner once a day at this UTC hour, and once at start when today's briefs are missing. */
export const BRAIN_BRIEF_SCHEDULE = { hourUtc: 6, passBudgetMs: 120_000 } as const;

/** brief/index.ts: the service, the runner and the scope_erased listener named "brief". */
export interface BrainBriefFeature {
  readonly service: BrainBriefService; readonly runner: BrainBriefRunner; readonly listener: BrainChangeListener;
}
