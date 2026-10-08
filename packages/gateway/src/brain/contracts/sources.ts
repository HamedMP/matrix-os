/**
 * Company Brain feature contract, part 3: source adapters, the shared sync runner, per-kind handlers, the
 * integration caller, connect configs and the /sources views. The git adapter (spec 552) is the pattern: stable
 * ids from an identity tuple, a cursor advanced in the same transaction as each batch, one receipt per run, stable
 * error codes, no provider text past server logs. Types and constants only.
 */
import type { BrainReceiptView } from "../api/types.js";
import type { BrainRepository } from "../repository.js";
import type {
  BrainScopeKey, BrainSourceStatus, BrainSyncCounts, BrainSyncReceipt, BrainSyncUpsertInput,
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

export interface BrainSourceSyncLimits {
  readonly pagesPerRun: number; readonly upsertsPerPage: number; readonly refsPerPage: number;
  readonly runBudgetMs: number; readonly providerTimeoutMs: number;
}
export const BRAIN_SOURCE_SYNC_DEFAULT_LIMITS: BrainSourceSyncLimits = {
  pagesPerRun: 20, upsertsPerPage: 100, refsPerPage: 5_000, runBudgetMs: 20_000, providerTimeoutMs: 10_000,
};
export const BRAIN_SOURCE_SYNC_LIMIT_CEILINGS: BrainSourceSyncLimits = {
  pagesPerRun: 200, upsertsPerPage: 200, refsPerPage: 10_000, runBudgetMs: 120_000, providerTimeoutMs: 30_000,
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
