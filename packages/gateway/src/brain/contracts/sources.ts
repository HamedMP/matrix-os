/**
 * Company Brain feature contract, part 3: source adapters, the shared sync runner, per-kind handlers, the
 * integration caller, connect configs and the /sources views. The git adapter (spec 552) is the pattern: stable
 * ids from an identity tuple, a cursor advanced in the same transaction as each batch, one receipt per run, stable
 * error codes, no provider text past server logs. Types and constants only.
 */
import type { Kysely } from "kysely";
import type { BrainReceiptView } from "../api/types.js";
import type { BrainRepository } from "../repository.js";
import type {
  BrainDatabase, BrainScopeKey, BrainSourceStatus, BrainSyncCounts, BrainSyncReceipt, BrainSyncUpsertInput,
} from "../types.js";
import type {
  BrainConnectableSourceKind, BrainProjectResolver, BrainResolvedProject, BrainSourceKind,
} from "./common.js";
import type { BrainChangeHooks } from "./hooks.js";

// Codes.

/**
 * The first five end a run before a receipt exists and are only returned. Every code matches
 * BRAIN_ERROR_CODE_PATTERN and is recorded verbatim on the receipt.
 */
export type BrainSourceErrorCode =
  | "invalid_options" | "source_unavailable" | "source_inactive" | "source_kind_mismatch" | "sync_in_progress"
  | "not_connected" | "auth_failed" | "rate_limited" | "provider_unavailable" | "provider_timeout"
  | "provider_output_invalid" | "remote_not_found" | "path_unsafe" | "config_invalid" | "cursor_conflict"
  | "cursor_invalid" | "brain_capacity" | "store_unavailable" | "document_invalid" | "internal_error";
export type BrainSourceInfoCode = "documents_rejected";
export type BrainSourceNextAction =
  "" | "run_again" | "retry_later" | "fix_source" | "connect_account" | "raise_capacity" | "contact_support";

export const BRAIN_SOURCE_NEXT_ACTIONS: Readonly<Record<BrainSourceErrorCode, BrainSourceNextAction>> = {
  invalid_options: "fix_source", source_unavailable: "fix_source", source_inactive: "fix_source",
  source_kind_mismatch: "fix_source", sync_in_progress: "retry_later", not_connected: "connect_account",
  auth_failed: "connect_account", rate_limited: "retry_later", provider_unavailable: "retry_later",
  provider_timeout: "retry_later", provider_output_invalid: "contact_support", remote_not_found: "fix_source",
  path_unsafe: "fix_source", config_invalid: "fix_source", cursor_conflict: "retry_later",
  cursor_invalid: "contact_support", brain_capacity: "raise_capacity", store_unavailable: "retry_later",
  document_invalid: "contact_support", internal_error: "contact_support",
};

/**
 * Unique, first-seen order, at most BRAIN_SOURCE_NOTICES_MAX per result. secret_skipped: items skipped because their
 * name or content looks like a credential (Matrix files); never counted as a plain skip notice.
 */
export const BRAIN_SOURCE_NOTICES = [
  "items_truncated", "body_truncated", "binary_skipped", "too_large_skipped", "pages_capped", "run_budget_exhausted",
  "history_window_limited", "not_modified", "private_body_omitted", "secret_skipped",
] as const;
export type BrainSourceNotice = (typeof BRAIN_SOURCE_NOTICES)[number];
export const BRAIN_SOURCE_NOTICES_MAX = 16;

// Adapter.

/** Read access an adapter may use (mark-and-sweep deletion, revision checks); never a write. */
export type BrainSourceDocumentReader = Pick<BrainRepository, "getDocument" | "listDocuments" | "listDocumentRefs">;

/** Upper bounds for one page; the runner passes min(limits, store caps). */
export interface BrainSourcePageLimits {
  readonly maxUpserts: number; readonly maxDeletions: number; readonly maxRefs: number;
}

export interface BrainSourceReadContext<TConfig> {
  readonly scope: BrainScopeKey; readonly sourceId: string;
  /** brain_sources.external_ref verbatim: the identity in every document id tuple. */
  readonly externalRef: string;
  readonly config: TConfig;
  /** The stored cursor; null on the first run. Adapter-defined, versioned (e.g. "gh1:" + base64url JSON). */
  readonly cursor: string | null;
  readonly limits: BrainSourcePageLimits;
  /**
   * Aborts when the caller aborts or at the per-page ceiling (BRAIN_SOURCE_SYNC_LIMIT_CEILINGS.runBudgetMs); the run
   * budget is checked between pages and never aborts a started page. Pass it (with a per-call timeout) to every
   * provider call.
   */
  readonly signal: AbortSignal;
  readonly documents: BrainSourceDocumentReader;
  readonly now: () => Date;
}

/**
 * One page, applied as one applySyncBatch moving the cursor to nextCursor. upserts: provenance must be one of
 * BRAIN_SOURCE_KIND_PROVENANCES[kind]; ids sha256 of [BRAIN_DOCUMENT_ID_VERSIONS[kind], externalRef, ...stable
 * tail], never of content; every ref follows BRAIN_REF_KINDS. deletions: ids this source owns that are gone
 * upstream. caughtUp: nothing newer is known after nextCursor. skipped: items read but not written.
 */
export interface BrainSourcePage {
  readonly upserts: readonly BrainSyncUpsertInput[]; readonly deletions: readonly string[];
  readonly nextCursor: string; readonly caughtUp: boolean; readonly skipped: number;
  readonly notices: readonly BrainSourceNotice[];
}

/** Expected failures are values; a thrown error becomes internal_error (logged by name). */
export type BrainSourceReadResult =
  | { readonly ok: true; readonly page: BrainSourcePage }
  | { readonly ok: false; readonly code: BrainSourceErrorCode; readonly retryAfterSeconds?: number };

export interface BrainSourceAdapter<TConfig> {
  readonly kind: BrainConnectableSourceKind;
  readPage(context: BrainSourceReadContext<TConfig>): Promise<BrainSourceReadResult>;
}

// Runner (sources/core/runner.ts implements BrainSourceSyncRunner).

/** Per-call provider timeouts belong to each kind's handler or client, not to the run. */
export interface BrainSourceSyncLimits {
  readonly pagesPerRun: number; readonly upsertsPerPage: number; readonly refsPerPage: number;
  readonly runBudgetMs: number;
}
export const BRAIN_SOURCE_SYNC_DEFAULT_LIMITS: BrainSourceSyncLimits = {
  pagesPerRun: 20, upsertsPerPage: 100, refsPerPage: 5_000, runBudgetMs: 20_000,
};
export const BRAIN_SOURCE_SYNC_LIMIT_CEILINGS: BrainSourceSyncLimits = {
  pagesPerRun: 200, upsertsPerPage: 200, refsPerPage: 10_000, runBudgetMs: 120_000,
};
/** In-process runs at once, one per (owner, scope, source); a capped Set guards re-entry, cleared in finally. */
export const BRAIN_SOURCE_MAX_CONCURRENT_SYNCS = 16;
export const BRAIN_SOURCE_REJECTED_IDS_MAX = 100;

export interface BrainSourceSyncOptions<TConfig> {
  readonly repository: BrainRepository; readonly scope: BrainScopeKey; readonly sourceId: string;
  readonly adapter: BrainSourceAdapter<TConfig>; readonly config: TConfig;
  readonly limits?: Partial<BrainSourceSyncLimits>;
  /** documents_changed after every committed batch, with that batch's upsert and deletion ids. */
  readonly hooks?: BrainChangeHooks;
  readonly signal?: AbortSignal;
  /** Milliseconds clock for the run budget; default Date.now. */
  readonly now?: () => number;
}

/**
 * Never rejects. Order: validate options, live active source of adapter.kind, re-entry guard, open receipt, pages
 * until caughtUp / pagesPerRun / budget (a started page always finishes), close receipt with counts and the code.
 * read = written + unchanged + deleted + failed, as the git adapter counts. retryAfterSeconds: from rate_limited.
 */
export interface BrainSourceSyncResult {
  readonly status: "succeeded" | "partial" | "failed";
  readonly errorCode: BrainSourceErrorCode | BrainSourceInfoCode | null;
  readonly nextAction: BrainSourceNextAction;
  readonly receipt: BrainSyncReceipt | null;
  readonly counts: BrainSyncCounts;
  readonly caughtUp: boolean; readonly pages: number; readonly skipped: number;
  readonly retryAfterSeconds: number | null;
  readonly rejectedDocumentIds: readonly string[];
  readonly notices: readonly BrainSourceNotice[];
}

export type BrainSourceSyncRunner = <TConfig>(options: BrainSourceSyncOptions<TConfig>) => Promise<BrainSourceSyncResult>;

// Integration caller (sources/integration/ implements it over the gateway's integration layer; tests use fakes).

/** Registry service ids the brain calls (packages/gateway/src/integrations registry). */
export const BRAIN_INTEGRATION_SERVICES = [
  "github", "linear", "google_drive", "google_docs", "google_calendar",
] as const;
export type BrainIntegrationService = (typeof BRAIN_INTEGRATION_SERVICES)[number];

/** action: a registry action id with risk "read"; params are validated by the registry before any call. */
export interface BrainIntegrationCallRequest {
  readonly service: BrainIntegrationService; readonly action: string;
  readonly params: Readonly<Record<string, unknown>>;
  /** The connection label when the owner has more than one account; omitted: the only or default one. */
  readonly label?: string;
}

/** data is untrusted provider JSON: the adapter parses it with a strict, bounded schema before use. */
export type BrainIntegrationCallOutcome =
  | { readonly status: "ok"; readonly data: unknown }
  | { readonly status: "not_connected" } | { readonly status: "unauthorized" }
  | { readonly status: "rate_limited"; readonly retryAfterSeconds: number }
  | { readonly status: "not_found" } | { readonly status: "invalid" } | { readonly status: "unavailable" };

/**
 * One read action per call for one owner; never throws for provider or transport failures (unavailable), rejects
 * only on abort. Bounds: response body BRAIN_INTEGRATION_RESPONSE_MAX_BYTES, timeout min(signal, provider timeout).
 */
export interface BrainIntegrationCaller {
  call(ownerId: string, request: BrainIntegrationCallRequest, signal: AbortSignal): Promise<BrainIntegrationCallOutcome>;
}
export const BRAIN_INTEGRATION_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
export const BRAIN_INTEGRATION_RETRY_AFTER_MAX_SECONDS = 3_600;

// Connect configs. Every list is bounded and validated by the kind handler; credentials are never part of a config.

export interface BrainGithubSourceConfig {
  /**
   * "owner/name"; must equal the git source's github.com repository when known (its web base, or the repository in
   * its synced git_pr / git_commit permalinks).
   */
  readonly repo: string;
  /** integration: the owner's connected GitHub account. token: MATRIX_BRAIN_GITHUB_TOKEN, read per run (self-host). */
  readonly mode: "integration" | "token";
  readonly accountLabel?: string;
  readonly include: { readonly pullRequests: boolean; readonly reviews: boolean; readonly issues: boolean };
  /** YYYY-MM-DD; nothing updated before it is read. Default: 365 days before the first run. */
  readonly since?: string;
}
/** folders: Notes folders to include (empty: every note of the owner). */
export interface BrainMatrixNotesSourceConfig { readonly folders: readonly string[] }
/** roots: 1..8 home-relative folders; extensions: lowercase without dot, 1..32; files over maxFileBytes are skipped. */
export interface BrainMatrixFilesSourceConfig {
  readonly roots: readonly string[]; readonly extensions: readonly string[]; readonly maxFileBytes: number;
}
/** chatIds: 1..50 chats the owner opted in explicitly; never any other chat. */
export interface BrainMatrixChatSourceConfig { readonly chatIds: readonly string[] }
export interface BrainLinearSourceConfig {
  readonly teamKeys: readonly string[]; readonly accountLabel?: string;
  readonly include: { readonly issues: boolean; readonly comments: boolean; readonly projectUpdates: boolean };
}
export interface BrainGoogleDriveSourceConfig { readonly folderIds: readonly string[]; readonly accountLabel?: string }
/** includeEventBodies: descriptions are stored only when true; attendees and times always. */
export interface BrainGoogleCalendarSourceConfig {
  readonly calendarIds: readonly string[]; readonly accountLabel?: string; readonly includeEventBodies: boolean;
  readonly pastDays: number; readonly futureDays: number;
}
/** companyScopeId: the Company Brain (company_brain_*) scope whose captured Slack threads are read. */
export interface BrainSlackBridgeSourceConfig { readonly companyScopeId: string; readonly channelIds: readonly string[] }

export interface BrainSourceConfigByKind {
  github: BrainGithubSourceConfig; matrix_notes: BrainMatrixNotesSourceConfig;
  matrix_files: BrainMatrixFilesSourceConfig; matrix_chat: BrainMatrixChatSourceConfig;
  linear: BrainLinearSourceConfig; google_drive: BrainGoogleDriveSourceConfig;
  google_calendar: BrainGoogleCalendarSourceConfig; slack_bridge: BrainSlackBridgeSourceConfig;
}

export const BRAIN_SOURCE_CONFIG_LIMITS = {
  /** JSON bytes of one stored config. */
  configMaxBytes: 8 * 1024, listItemMaxChars: 256, githubSinceMaxDays: 3_650,
  matrixFileRoots: 8, matrixFileExtensions: 32, matrixFileMaxBytesDefault: 262_144, matrixFileMaxBytesCeiling: 1_048_576,
  matrixChats: 50, linearTeams: 20, driveFolders: 20, calendars: 10, calendarPastDaysMax: 90, calendarFutureDaysMax: 90,
  slackChannels: 50,
} as const;

// Kind handlers (one per connectable kind; sources/core keeps the registry and the /sources routes).

/** A redacted, client-safe config: no token, no home path outside the configured roots, bounded values. */
export type BrainSourceConfigView = Readonly<Record<string, string | number | boolean | readonly string[] | null>>;

export type BrainSourceAdapterResolution<TConfig> =
  | { readonly ok: true; readonly adapter: BrainSourceAdapter<TConfig> }
  | { readonly ok: false; readonly code: "not_connected" | "auth_failed" | "config_invalid" };

export interface BrainSourceOptionsQuery { readonly q?: string; readonly cursor?: string }
export interface BrainSourceOptionView { readonly id: string; readonly label: string; readonly detail: string | null }
export interface BrainSourceOptionsView {
  readonly kind: BrainConnectableSourceKind; readonly items: readonly BrainSourceOptionView[];
  readonly nextCursor: string | null;
}
export const BRAIN_SOURCE_OPTIONS_MAX = 100;

/**
 * Config rows live in the handler's own prefixed table keyed by (owner_id, scope_id, source_id), referencing
 * brain_sources ON DELETE CASCADE. parseConfig throws BrainFeatureError("source_config_invalid"). identify never
 * touches the network. createAdapter reads credentials per run and never keeps them. The sources service connects in
 * this order: parseConfig, checkConfig, createSource, saveConfig, and deleteSource when saveConfig still throws, so a
 * refused config never leaves a live brain_sources row. A config update saves inside the transaction that moves the
 * source revision (saveConfig's `db`), so the config and the revision commit together or not at all.
 */
export interface BrainSourceKindHandler<TConfig> {
  readonly kind: BrainConnectableSourceKind;
  parseConfig(raw: unknown): TConfig;
  /** Refuses a config before the source row is created (for example source_conflict); never writes. */
  checkConfig?(scope: BrainScopeKey, config: TConfig): Promise<void>;
  identify(project: BrainResolvedProject, config: TConfig): { readonly externalRef: string; readonly label: string };
  /** db: the open transaction to write in (the handler's lock is taken inside it); absent, its own transaction. */
  saveConfig(scope: BrainScopeKey, sourceId: string, config: TConfig, db?: Kysely<BrainDatabase>): Promise<void>;
  loadConfig(scope: BrainScopeKey, sourceId: string): Promise<TConfig | null>;
  createAdapter(ownerId: string, project: BrainResolvedProject, config: TConfig): Promise<BrainSourceAdapterResolution<TConfig>>;
  viewConfig(config: TConfig): BrainSourceConfigView;
  /** Whether the kind can be connected now (account connected, environment configured); no provider content. */
  availability(ownerId: string): Promise<BrainSourceKindAvailability>;
  listOptions?(ownerId: string, project: BrainResolvedProject, query: BrainSourceOptionsQuery, signal: AbortSignal):
    Promise<BrainSourceOptionsView>;
}
/** Method parameters are bivariant, so every BrainSourceKindHandler<TConfig> is assignable here. */
export type BrainAnySourceKindHandler = BrainSourceKindHandler<unknown>;

export type BrainSourceKindAvailability =
  | { readonly available: true } | { readonly available: false; readonly reason: "not_connected" | "not_configured" };

// /sources views.

export interface BrainSourceLastSyncView {
  readonly status: BrainReceiptView["status"]; readonly startedAt: string; readonly finishedAt: string | null;
  readonly nextAction: string; readonly errorCode: string | null;
}

/** externalRef is shown only for git and github (a repository identity); null for every other kind. */
export interface BrainSourceView {
  readonly sourceId: string; readonly kind: BrainSourceKind; readonly label: string;
  readonly externalRef: string | null; readonly status: BrainSourceStatus; readonly revision: number;
  readonly createdAt: string; readonly updatedAt: string; readonly config: BrainSourceConfigView | null;
  readonly lastSync: BrainSourceLastSyncView | null;
}
export interface BrainSourceKindView {
  readonly kind: BrainSourceKind; readonly available: boolean;
  readonly reason: "not_connected" | "not_configured" | null;
}
export interface BrainSourcesView { readonly items: readonly BrainSourceView[]; readonly kinds: readonly BrainSourceKindView[] }

export interface BrainConnectSourceInput {
  readonly kind: BrainConnectableSourceKind; readonly config: unknown; readonly label?: string;
}
export interface BrainConnectSourceResult { readonly source: BrainSourceView; readonly created: boolean }
/** expectedRevision: the source revision the client loaded; a miss is revision_conflict. */
export interface BrainUpdateSourceInput {
  readonly expectedRevision: number; readonly status?: "active" | "paused"; readonly config?: unknown;
  readonly label?: string;
}

export interface BrainSourceSyncView {
  readonly sourceId: string; readonly status: BrainSourceSyncResult["status"];
  readonly errorCode: BrainSourceErrorCode | BrainSourceInfoCode | null; readonly nextAction: BrainSourceNextAction;
  readonly caughtUp: boolean; readonly pages: number; readonly counts: BrainSyncCounts;
  readonly notices: readonly BrainSourceNotice[]; readonly retryAfterSeconds: number | null;
  readonly receipt: BrainReceiptView | null;
}
export interface BrainSourceReceiptsView { readonly source: BrainSourceView; readonly receipts: readonly BrainReceiptView[] }

export const BRAIN_SOURCES_BODY_MAX_BYTES = { connect: 16 * 1024, update: 16 * 1024, sync: 1_024, remove: 1_024 } as const;

/**
 * Built by sources/core createBrainSourcesService. gitSync: BrainProjectService.sync mapped to a sync view, used
 * when POST /sources/:sourceId/sync names the git source (absent: that request is source_kind_unsupported); the
 * service sets the view's sourceId to the source the client named. accounts: the owner's connection labels of a
 * service (no provider call); present, a connect pins one account (several and none named: source_config_invalid).
 */
export interface BrainSourcesServiceDeps {
  readonly repository: BrainRepository; readonly resolver: BrainProjectResolver;
  readonly handlers: readonly BrainAnySourceKindHandler[]; readonly runner: BrainSourceSyncRunner;
  readonly hooks?: BrainChangeHooks; readonly limits?: Partial<BrainSourceSyncLimits>;
  readonly gitSync?: (ownerId: string, projectRef: string) => Promise<BrainSourceSyncView>;
  readonly accounts?: (ownerId: string, service: BrainIntegrationService) => Promise<readonly string[]>;
}

/** Owner-scoped /sources service (sources/core). sync: exactly one bounded run; git sources delegate to gitSync. */
export interface BrainSourcesService {
  list(ownerId: string, projectRef: string): Promise<BrainSourcesView>;
  connect(ownerId: string, projectRef: string, input: BrainConnectSourceInput): Promise<BrainConnectSourceResult>;
  options(ownerId: string, projectRef: string, kind: BrainConnectableSourceKind, query: BrainSourceOptionsQuery):
    Promise<BrainSourceOptionsView>;
  update(ownerId: string, projectRef: string, sourceId: string, input: BrainUpdateSourceInput): Promise<BrainSourceView>;
  remove(ownerId: string, projectRef: string, sourceId: string, expectedRevision: number): Promise<BrainSourceView>;
  /** signal: the caller's stop (a background run's cancel, time cap or shutdown); it ends the run between pages. */
  sync(ownerId: string, projectRef: string, sourceId: string, signal?: AbortSignal): Promise<BrainSourceSyncView>;
  receipts(ownerId: string, projectRef: string, sourceId: string, limit: number): Promise<BrainSourceReceiptsView>;
}
