/**
 * Company Brain views as the Matrix OS views see them. The UI package cannot import the gateway, so these are
 * structural copies of the gateway views (packages/gateway/src/brain/contracts/ and brain/api/). Long code unions the
 * screens never branch on are kept as `string`, which every gateway value still satisfies. Answers no screen renders
 * yet (entity, links, alias, refreshes, stale, impact) are `unknown` until a screen renders one and copies its shape.
 */

export const BRAIN_SHELL_VIEW = {
  path: "__brain__", title: "Company Brain", aliases: ["brain", "company-brain", "apps/brain/index.html"],
  defaultWidth: 1100, defaultHeight: 720, minWidth: 360, minHeight: 420,
} as const;
export const BRAIN_SHELL_SCREENS = [
  "ask", "today", "decisions", "commitments", "risks", "timeline", "sources",
] as const;
export type BrainShellScreen = (typeof BRAIN_SHELL_SCREENS)[number];
/** Words that find "Open Company Brain" in the command palette of every surface. */
export const BRAIN_APP_KEYWORDS = ["brain", "company", "decisions", "commitments", "risks", "why", "search"] as const;

export type BrainShellErrorState =
  | { readonly kind: "unauthorized" } | { readonly kind: "offline" } | { readonly kind: "timeout" }
  | { readonly kind: "not_found"; readonly code: string } | { readonly kind: "unavailable" }
  | { readonly kind: "rejected"; readonly code: string };

/** The fixed client-safe text of every /api/brain error code (BRAIN_API_ERRORS and BRAIN_FEATURE_ERRORS). */
export const BRAIN_ERROR_COPY: Readonly<Record<string, string>> = {
  invalid_request: "Check what you typed and try again.",
  project_not_found: "Project not found.",
  git_source_missing: "Connect this project's repository in Sources first.",
  git_source_conflict: "This project already has a different repository source.",
  git_source_unavailable: "The repository source is paused.",
  checkout_unavailable: "The project checkout is unavailable.",
  sync_in_progress: "A sync is already running for this project.",
  extractor_not_configured: "No claim reading model is set up.",
  extraction_in_progress: "Claims are already being read for this project.",
  brain_capacity: "The project brain is full.",
  body_too_large: "That request is too large.",
  brain_unavailable: "The Company Brain is unavailable.",
  source_not_found: "That source no longer exists. Reload to see the current list.",
  source_conflict: "This project already has a different source of that kind.",
  source_not_connected: "Connect the account for this source in Settings first.",
  source_auth_failed: "The account for this source needs to be reconnected in Settings.",
  source_config_invalid: "Those source settings are not valid.",
  source_kind_unsupported: "This source kind is not available.",
  revision_conflict: "This changed since it was loaded. Reload and try again.",
  entity_not_found: "Nothing in the brain matches that yet.",
  alias_conflict: "That alias belongs to someone else.",
  git_ref_not_found: "Branch or commit not found.",
  job_not_found: "That background run no longer exists.",
  job_kind_unavailable: "This kind of background run is not available.",
  jobs_full: "Too many runs are waiting. Try again later.",
  vector_search_unavailable: "Meaning search is not available.",
  summary_not_configured: "Brief summaries are turned off.",
};
/** Codes that mean "connect something first": the screens offer a way to Sources. */
export const BRAIN_NOT_CONNECTED_CODES = ["git_source_missing", "source_not_connected", "source_auth_failed"] as const;

// Shared.

export const BRAIN_CLAIM_KINDS = ["invariant", "decision", "commitment", "risk"] as const;
export type BrainClaimKind = (typeof BRAIN_CLAIM_KINDS)[number];
export type BrainCiteKind =
  | "pr" | "commit" | "spec" | "review" | "comment" | "issue" | "note" | "file" | "chat" | "doc" | "event" | "update"
  | "thread" | "document";
export interface BrainCiteView {
  readonly documentId: string; readonly kind: BrainCiteKind; readonly provenance: string;
  readonly sourceId: string | null; readonly label: string; readonly title: string; readonly permalink: string;
  readonly date: string; readonly revision: number;
}
export interface BrainSyncCounts {
  readonly read: number; readonly written: number; readonly unchanged: number; readonly deleted: number;
  readonly failed: number;
}
export type BrainSourceStatus = "active" | "paused" | "disabled";
export type BrainReceiptStatus = "running" | "succeeded" | "partial" | "failed" | "interrupted";
export interface BrainReceiptView {
  readonly receiptId: string; readonly status: BrainReceiptStatus; readonly counts: BrainSyncCounts;
  readonly nextAction: string; readonly errorCode: string | null; readonly startedAt: string;
  readonly finishedAt: string | null;
}
export interface BrainIndexFreshness {
  readonly caughtUp: boolean; readonly pendingDocuments: number; readonly pendingCapped: boolean;
}

// Core project routes (specs 552-554).

export interface BrainGitSourceView {
  readonly sourceId: string; readonly label: string; readonly externalRef: string; readonly webBase: string | null;
  readonly status: BrainSourceStatus; readonly createdAt: string; readonly updatedAt: string;
}
export interface BrainRegisterGitSourceInput { readonly webBase?: string }
export interface BrainRegisterGitSourceResult { readonly source: BrainGitSourceView; readonly created: boolean }
export interface BrainReceiptsView { readonly source: BrainGitSourceView | null; readonly receipts: readonly BrainReceiptView[] }
export interface BrainSyncView {
  readonly status: "succeeded" | "partial" | "failed"; readonly errorCode: string | null; readonly nextAction: string;
  readonly caughtUp: boolean; readonly commitsProcessed: number; readonly commitsRemaining: number;
  readonly counts: BrainSyncCounts; readonly notices: readonly string[]; readonly receipt: BrainReceiptView | null;
}
export interface BrainWhyQuery {
  readonly path: string; readonly limit?: number; readonly cursor?: string | null; readonly detail?: "brief" | "full";
}
export interface BrainWhyExcerpt { readonly heading: string | null; readonly text: string; readonly truncated: boolean }
export interface BrainWhyItem {
  readonly documentId: string; readonly kind: "pr" | "commit" | "spec"; readonly label: string; readonly title: string;
  readonly date: string; readonly permalink: string; readonly link: "explicit" | "inferred" | "none";
  readonly summary: BrainWhyExcerpt | null; readonly matchedPaths: readonly string[];
  readonly matchedPathCount: number;
}
/** Newest first. source: null when the project has no git source yet (items is then empty). */
export interface BrainWhyResult {
  readonly path: string; readonly match: "file_or_folder" | "folder"; readonly total: number;
  readonly totalCapped: boolean; readonly items: readonly BrainWhyItem[]; readonly nextCursor: string | null;
  readonly source: { readonly sourceId: string; readonly webBase: string | null } | null;
}
export interface BrainExtractInput { readonly extractor: "rules" | "model" }
export interface BrainExtractionCounts {
  readonly documentsProcessed: number; readonly documentsFailed: number; readonly claimsWritten: number;
  readonly claimsRemoved: number; readonly claimsRejected: number; readonly quotesRejected: number;
}
export interface BrainExtractionUsage {
  readonly inputTokens: number; readonly outputTokens: number; readonly costMicroUsd: number;
  readonly cacheReadTokens: number; readonly cacheWriteTokens: number;
}
/** Model extraction spend of the project over the last 30 days against its cap, in micro-USD. */
export interface BrainModelSpend {
  readonly windowStart: string; readonly capMicroUsd: number; readonly spentMicroUsd: number;
  readonly remainingMicroUsd: number;
}
export interface BrainExtractView {
  readonly status: "succeeded" | "partial" | "failed"; readonly errorCode: string | null; readonly nextAction: string;
  readonly extractor: string; readonly counts: BrainExtractionCounts; readonly usage: BrainExtractionUsage;
  readonly caughtUp: boolean;
  /** Model runs only: the window the run checked. */
  readonly spend?: BrainModelSpend;
  readonly run: {
    readonly runId: string; readonly extractor: string; readonly status: string;
    readonly counts: BrainExtractionCounts; readonly usage: BrainExtractionUsage; readonly nextAction: string;
    readonly errorCode: string | null; readonly startedAt: string; readonly finishedAt: string | null;
  } | null;
}
export interface BrainClaimDocumentView {
  readonly documentId: string; readonly kind: "pr" | "commit" | "spec" | "document"; readonly label: string;
  readonly title: string; readonly permalink: string; readonly date: string; readonly revision: number;
}
export interface BrainClaimFields {
  readonly assignee?: string; readonly due?: string; readonly severity?: "low" | "medium" | "high";
}
export interface BrainClaimView {
  readonly claimId: string; readonly kind: BrainClaimKind; readonly label: string | null; readonly statement: string;
  readonly quote: string; readonly spanStart: number; readonly spanEnd: number; readonly fields: BrainClaimFields;
  readonly confidence: "high" | "medium" | "low"; readonly extractor: string; readonly revision: number;
  readonly createdAt: string; readonly stale: boolean; readonly document: BrainClaimDocumentView;
}
export interface BrainClaimsQuery {
  readonly kind?: BrainClaimKind; readonly path?: string; readonly limit: number; readonly cursor?: string;
}
export interface BrainClaimsView {
  readonly kind: BrainClaimKind | null; readonly path: string | null; readonly match: "file_or_folder" | "folder" | null;
  readonly items: readonly BrainClaimView[]; readonly nextCursor: string | null;
  /** Null when the gateway has no model extractor settings. */
  readonly modelSpend: BrainModelSpend | null;
}

// Search (spec 556).

export interface BrainSearchQuery {
  readonly q: string; readonly types?: readonly ("document" | "claim")[]; readonly kinds?: readonly BrainCiteKind[];
  readonly claimKinds?: readonly BrainClaimKind[]; readonly sourceId?: string; readonly from?: string;
  readonly to?: string; readonly path?: string; readonly mode?: "auto" | "text" | "hybrid"; readonly limit?: number;
  readonly cursor?: string;
}
export interface BrainSnippetView {
  readonly field: "title" | "body" | "label" | "statement" | "quote"; readonly text: string;
  readonly highlights: readonly (readonly [number, number])[];
  readonly truncatedStart: boolean; readonly truncatedEnd: boolean;
}
export interface BrainSearchHitView {
  readonly hitId: string; readonly type: "document" | "claim"; readonly score: number;
  readonly matchedBy: readonly ("text" | "vector")[]; readonly snippet: BrainSnippetView;
  readonly claim: {
    readonly claimId: string; readonly kind: BrainClaimKind; readonly label: string | null;
    readonly statement: string; readonly extractor: string; readonly stale: boolean;
  } | null;
  readonly cite: BrainCiteView;
}
export interface BrainSearchView {
  readonly q: string; readonly mode: "text" | "hybrid"; readonly items: readonly BrainSearchHitView[];
  readonly nextCursor: string | null;
  readonly capability: {
    readonly fullText: true; readonly vector: "available" | "extension_missing" | "provider_not_configured";
    readonly providerId: string | null; readonly store?: "pgvector" | "array";
  };
  readonly freshness: BrainIndexFreshness; readonly notices: readonly string[];
}

// Graph (spec 557).

export type BrainEntityKind =
  "person" | "file" | "folder" | "spec" | "pull_request" | "issue" | "project" | "document";
export type BrainLinkType =
  | "authored" | "reviewed" | "changed" | "mentions" | "implements_spec" | "references_issue" | "decided_in"
  | "describes" | "part_of";
export interface BrainEntityRefView {
  readonly entityId: string; readonly kind: BrainEntityKind; readonly key: string; readonly displayName: string;
}
export interface BrainTimelineItemView {
  readonly cite: BrainCiteView; readonly linkTypes: readonly BrainLinkType[]; readonly mode: "explicit" | "inferred";
  readonly matchedPaths: readonly string[];
}
export interface BrainTimelineView {
  readonly entity: BrainEntityRefView; readonly items: readonly BrainTimelineItemView[];
  readonly nextCursor: string | null; readonly freshness: BrainIndexFreshness;
}
export interface BrainEntitiesView { readonly items: readonly BrainEntityRefView[]; readonly nextCursor: string | null }
export interface BrainTimelineQuery {
  readonly entity: string; readonly linkTypes?: readonly BrainLinkType[]; readonly from?: string;
  readonly to?: string; readonly limit?: number; readonly cursor?: string;
}
export interface BrainEntitiesQuery {
  readonly kind?: BrainEntityKind; readonly q?: string; readonly limit?: number; readonly cursor?: string;
}
export interface BrainLinksQuery {
  readonly hops?: 1 | 2; readonly types?: readonly BrainLinkType[]; readonly direction?: "out" | "in" | "both";
  readonly limit?: number; readonly cursor?: string;
}
/** merge; split: "not the same person" (kept); unmerge: Undo of a manual merge (leaves nothing behind). */
export interface BrainAliasInput { readonly action: "merge" | "split" | "unmerge"; readonly aliasKey: string }
/** signal: why two people look like one (same_github_login, name_matches_login, ...); detail: the login or name. */
export interface BrainMergeEvidenceView {
  readonly signal: string; readonly detail: string; readonly documents: number | null;
}
/**
 * entity stays; alias would merge into it (POST entities/:entityId/aliases with aliasKey). Never merged without the
 * owner. score: 0.5 to 0.99. counts: links of each side and how many entities would move.
 */
export interface BrainMergeSuggestionView {
  readonly suggestionId: string; readonly score: number; readonly entity: BrainEntityRefView;
  readonly alias: BrainEntityRefView; readonly aliasKey: string; readonly evidence: readonly BrainMergeEvidenceView[];
  readonly counts: { readonly entityLinks: number; readonly aliasLinks: number; readonly aliasEntities: number };
}
export interface BrainMergeSuggestionsView {
  readonly items: readonly BrainMergeSuggestionView[]; readonly nextCursor: string | null; readonly truncated: boolean;
}
export interface BrainMergeSuggestionsQuery { readonly limit?: number; readonly cursor?: string }

// Sources (specs 558-560).

export type BrainSourceKind =
  | "git" | "github" | "matrix_notes" | "matrix_files" | "matrix_chat" | "linear" | "google_drive"
  | "google_calendar" | "slack_bridge";
export type BrainConnectableSourceKind = Exclude<BrainSourceKind, "git">;
export type BrainSourceConfigView = Readonly<Record<string, string | number | boolean | readonly string[] | null>>;
export interface BrainSourceView {
  readonly sourceId: string; readonly kind: BrainSourceKind; readonly label: string;
  readonly externalRef: string | null; readonly status: BrainSourceStatus; readonly revision: number;
  readonly createdAt: string; readonly updatedAt: string; readonly config: BrainSourceConfigView | null;
  readonly lastSync: Omit<BrainReceiptView, "receiptId" | "counts"> | null;
}
export interface BrainSourceKindView {
  readonly kind: BrainSourceKind; readonly available: boolean; readonly reason: "not_connected" | "not_configured" | null;
}
export interface BrainSourcesView { readonly items: readonly BrainSourceView[]; readonly kinds: readonly BrainSourceKindView[] }
export interface BrainConnectSourceInput {
  readonly kind: BrainConnectableSourceKind; readonly config: unknown; readonly label?: string;
}
export interface BrainConnectSourceResult { readonly source: BrainSourceView; readonly created: boolean }
export interface BrainSourceOptionsQuery { readonly q?: string; readonly cursor?: string }
export interface BrainSourceOptionView { readonly id: string; readonly label: string; readonly detail: string | null }
export interface BrainSourceOptionsView {
  readonly kind: BrainConnectableSourceKind; readonly items: readonly BrainSourceOptionView[];
  readonly nextCursor: string | null;
}
export interface BrainUpdateSourceInput {
  readonly expectedRevision: number; readonly status?: "active" | "paused"; readonly config?: unknown;
  readonly label?: string;
}
export interface BrainSourceSyncView {
  readonly sourceId: string; readonly status: "succeeded" | "partial" | "failed"; readonly errorCode: string | null;
  readonly nextAction: string; readonly caughtUp: boolean; readonly pages: number; readonly counts: BrainSyncCounts;
  readonly notices: readonly string[]; readonly retryAfterSeconds: number | null;
  readonly receipt: BrainReceiptView | null;
}
export interface BrainSourceReceiptsView { readonly source: BrainSourceView; readonly receipts: readonly BrainReceiptView[] }

// Brief (spec 561).

export type BrainBriefWindow = "day" | "week";
export interface BrainBriefLine {
  readonly lineId: string; readonly text: string; readonly cites: readonly BrainCiteView[];
  readonly claimId: string | null; readonly claimKind: BrainClaimKind | null; readonly due: string | null;
  readonly assignee: string | null; readonly severity: "low" | "medium" | "high" | null;
}
export interface BrainBriefChangeGroup {
  readonly sourceId: string | null; readonly sourceKind: string | null; readonly label: string;
  readonly created: number; readonly revised: number; readonly items: readonly BrainBriefLine[];
}
export interface BrainBriefView {
  readonly date: string; readonly window: BrainBriefWindow; readonly from: string; readonly to: string;
  readonly generatedAt: string;
  readonly sections: {
    readonly changes: readonly BrainBriefChangeGroup[]; readonly decisions: readonly BrainBriefLine[];
    readonly commitments: readonly BrainBriefLine[]; readonly risks: readonly BrainBriefLine[];
    readonly attention: readonly BrainBriefLine[];
  };
  readonly summary: { readonly text: string; readonly modelId: string; readonly generatedAt: string } | null;
  readonly truncated: boolean; readonly stored: boolean;
}
export interface BrainBriefQuery { readonly date?: string; readonly window?: BrainBriefWindow }
export interface BrainBriefGenerateInput {
  readonly date?: string; readonly window?: BrainBriefWindow; readonly summary?: boolean;
}
export type BrainConflictRule = "label_disagreement" | "draft_spec_shipped" | "commitment_reversed";
export interface BrainConflictSideView {
  readonly cite: BrainCiteView; readonly claimId: string | null; readonly statement: string | null;
  readonly quote: string;
}
export interface BrainConflictView {
  readonly conflictId: string; readonly rule: BrainConflictRule; readonly summary: string;
  readonly sides: readonly [BrainConflictSideView, BrainConflictSideView]; readonly detectedAt: string;
}
export interface BrainConflictsView { readonly items: readonly BrainConflictView[]; readonly nextCursor: string | null }
export interface BrainConflictsQuery {
  readonly rules?: readonly BrainConflictRule[]; readonly limit?: number; readonly cursor?: string;
}
export type BrainStaleKind = "claim_outdated" | "source_sync_old" | "source_failing" | "commitment_overdue";
export interface BrainStaleQuery { readonly kinds?: readonly BrainStaleKind[]; readonly limit?: number; readonly cursor?: string }

// Impact (spec 564).

export interface BrainImpactQuery { readonly head: string; readonly base?: string; readonly depth?: 1 | 2 }
/** One method per /api/brain route; every method takes a project id or slug. */
export interface BrainShellApi {
  registerGitSource(projectId: string, input: BrainRegisterGitSourceInput): Promise<BrainRegisterGitSourceResult>;
  syncGit(projectId: string): Promise<BrainSyncView>;
  gitReceipts(projectId: string, limit?: number): Promise<BrainReceiptsView>;
  why(projectId: string, query: BrainWhyQuery): Promise<BrainWhyResult>;
  extract(projectId: string, input: BrainExtractInput): Promise<BrainExtractView>;
  claims(projectId: string, query: Partial<BrainClaimsQuery>): Promise<BrainClaimsView>;
  search(projectId: string, query: BrainSearchQuery): Promise<BrainSearchView>;
  refreshSearch(projectId: string): Promise<unknown>;
  timeline(projectId: string, query: BrainTimelineQuery): Promise<BrainTimelineView>;
  entities(projectId: string, query: BrainEntitiesQuery): Promise<BrainEntitiesView>;
  entity(projectId: string, entityId: string): Promise<unknown>;
  entityLinks(projectId: string, entityId: string, query: BrainLinksQuery): Promise<unknown>;
  updateAlias(projectId: string, entityId: string, input: BrainAliasInput): Promise<unknown>;
  refreshGraph(projectId: string): Promise<unknown>;
  sources(projectId: string): Promise<BrainSourcesView>;
  connectSource(projectId: string, input: BrainConnectSourceInput): Promise<BrainConnectSourceResult>;
  sourceOptions(projectId: string, kind: BrainConnectableSourceKind, query: BrainSourceOptionsQuery):
    Promise<BrainSourceOptionsView>;
  updateSource(projectId: string, sourceId: string, input: BrainUpdateSourceInput): Promise<BrainSourceView>;
  removeSource(projectId: string, sourceId: string, expectedRevision: number): Promise<BrainSourceView>;
  syncSource(projectId: string, sourceId: string): Promise<BrainSourceSyncView>;
  sourceReceipts(projectId: string, sourceId: string, limit?: number): Promise<BrainSourceReceiptsView>;
  brief(projectId: string, query: BrainBriefQuery): Promise<BrainBriefView>;
  generateBrief(projectId: string, input: BrainBriefGenerateInput): Promise<BrainBriefView>;
  conflicts(projectId: string, query: BrainConflictsQuery): Promise<BrainConflictsView>;
  stale(projectId: string, query: BrainStaleQuery): Promise<unknown>;
  impact(projectId: string, query: BrainImpactQuery): Promise<unknown>;
  mergeSuggestions(projectId: string, query: BrainMergeSuggestionsQuery): Promise<BrainMergeSuggestionsView>;
  // Background runs: the answers are read field by field (use-brain-job.ts), so they stay `unknown` here.
  /** 202 { job, deduped }: the new job, or the queued or running one of the same kind and target. */
  startJob(projectId: string, input: BrainJobStartInput): Promise<unknown>;
  job(projectId: string, jobId: string): Promise<unknown>;
  jobs(projectId: string, limit?: number): Promise<unknown>;
  cancelJob(projectId: string, jobId: string): Promise<unknown>;
}

// Background runs (spec 566).

export type BrainJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
/** POST .../jobs body, one shape per kind (the gateway's BrainJobRequestInput). */
export type BrainJobStartInput =
  | { readonly kind: "sync"; readonly sourceId?: string }
  | { readonly kind: "extract"; readonly extractor?: "rules" | "model" }
  | { readonly kind: "search_refresh" } | { readonly kind: "graph_refresh" }
  | { readonly kind: "brief"; readonly window?: BrainBriefWindow };
/** Why a run stopped, beyond the API error codes: the run's own limits. */
export const BRAIN_JOB_CODE_COPY: Readonly<Record<string, string>> = {
  ...BRAIN_ERROR_COPY,
  time_limit: "It ran out of time; start it again to go on.",
  step_limit: "It reached its step limit; start it again to go on.",
  attempts_exhausted: "It stopped after several restarts. Try again later.",
  interrupted: "It stopped early when the server restarted; run it again to continue.",
  embedding_unavailable: "Meaning search could not reach its provider; try again later.",
  vector_cap: "The search index is full.",
  graph_capacity: "The graph is full.",
};
/**
 * A job as the screens show it; errorCode is a known code or null, nextAction is worded by a fixed table. waiting: a
 * running job that is waiting for another run of the project to finish (present only then).
 */
export interface BrainJobView {
  readonly jobId: string; readonly status: BrainJobStatus; readonly steps: number | null;
  readonly errorCode: string | null; readonly nextAction: string; readonly waiting?: true;
}
/** What the screens call: every mirrored route. */
export type BrainShellClient = BrainShellApi;

/** A project the owner can open the brain of (GET /api/workspace/projects). */
export interface BrainProjectOption { readonly id: string; readonly name: string; readonly slug: string }
