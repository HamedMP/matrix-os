/**
 * Company Brain feature contract, part 2: change hooks, derived indexes and background jobs. A hook is only a
 * nudge: derived tables record the (incarnation, revision) they were built from, so a lost or failed hook is
 * repaired by the next bounded refresh. Types and constants only.
 */
import type { Kysely } from "kysely";
import type { BrainDatabase, BrainScopeKey } from "../types.js";
import type { BrainFeature } from "./common.js";

// Events.

/** Ids carried by one event; more than this is sent as null ("unknown set", listeners run a bounded catch-up). */
export const BRAIN_HOOK_DOCUMENT_IDS_MAX = 500;

/**
 * documents_changed: documents of the scope were created, revised or tombstoned (a source was deleted counts too).
 * documentIds: the affected ids (upserts and deletions of the committed batches), or null when not known.
 * claims_changed: an extraction run wrote or removed claims. scope_erased: repository.eraseScope committed.
 * at: ISO-8601 time the change committed.
 */
export type BrainChangeEvent =
  | {
    readonly type: "documents_changed"; readonly scope: BrainScopeKey; readonly sourceId: string | null;
    readonly documentIds: readonly string[] | null; readonly at: string;
  }
  | {
    readonly type: "claims_changed"; readonly scope: BrainScopeKey; readonly extractor: string;
    readonly documentIds: readonly string[] | null; readonly at: string;
  }
  | { readonly type: "scope_erased"; readonly scope: BrainScopeKey; readonly at: string };
export type BrainChangeEventType = BrainChangeEvent["type"];

export type BrainChangeListenerName = "search" | "graph" | "brief";

/** Who reacts to which event; a listener ignores every other type. */
export const BRAIN_HOOK_REACTIONS: Readonly<Record<BrainChangeEventType, readonly BrainChangeListenerName[]>> = {
  documents_changed: ["search", "graph", "brief"],
  claims_changed: ["search", "graph"],
  scope_erased: ["search", "graph", "brief"],
};

/**
 * Who emits. documents_changed: the source sync runner (sources/core) after every committed batch with its ids, and
 * the git sync wrapper (withBrainChangeEvents in api/start.ts) after a run that wrote or deleted anything (ids null).
 * claims_changed: the extract wrapper in api/start.ts after a run that wrote or removed claims (ids null).
 * scope_erased: the eraseBrainScope helper (brain/hooks.ts) after repository.eraseScope.
 */
export const BRAIN_HOOK_EMITTERS: Readonly<Record<BrainChangeEventType, readonly string[]>> = {
  documents_changed: ["sources/core runner", "api/start.ts sync wrapper"],
  claims_changed: ["api/start.ts extract wrapper"],
  scope_erased: ["eraseBrainScope helper"],
};

/**
 * A feature's reaction. Must be idempotent, bounded by the signal (BRAIN_HOOK_LISTENER_BUDGET_MS) and must not
 * throw for expected states (a document already gone, a scope already erased); unexpected errors reject and the bus
 * logs `[brain-hooks] <name> failed: <error name>`.
 */
export interface BrainChangeListener {
  readonly name: BrainChangeListenerName;
  handle(event: BrainChangeEvent, signal: AbortSignal): Promise<void>;
}

/**
 * The bus (brain/hooks.ts createBrainChangeHooks). emit never throws and never waits: events queue per scope
 * (coalesced: ids are merged, an overflow becomes null), listeners run after the emitting request has its result,
 * one scope at a time, listeners in BRAIN_HOOK_REACTIONS order. close() drains with a deadline on shutdown.
 */
export interface BrainChangeHooks {
  emit(event: BrainChangeEvent): void;
  close(deadlineMs: number): Promise<void>;
}
export const BRAIN_HOOK_LISTENER_BUDGET_MS = 30_000;
/** Scopes with queued events at once; the oldest queued scope's events collapse to one null-ids event beyond it. */
export const BRAIN_HOOK_QUEUE_MAX_SCOPES = 64;

// Derived indexes (search, graph).

/**
 * documents: live documents examined per call. budgetMs: wall clock, checked before each batch of documents and
 * before each provider call (a batch of SQL may finish past it; a provider call never starts past it).
 */
export interface BrainDerivedRefreshLimits { readonly documents: number; readonly budgetMs: number }
export const BRAIN_DERIVED_REFRESH_DEFAULTS: BrainDerivedRefreshLimits = { documents: 500, budgetMs: 20_000 };
export const BRAIN_DERIVED_REFRESH_CEILINGS: BrainDerivedRefreshLimits = { documents: 5_000, budgetMs: 120_000 };

/**
 * processed: documents (re)derived. removed: documents whose derived rows were dropped (tombstoned or gone).
 * caughtUp: no missing, outdated or orphaned document is left for this index.
 */
/**
 * Why a refresh cannot catch up until something changes, so running it again at once is pointless:
 * embedding_unavailable (the embeddings provider is not configured, refused the key or is unavailable), vector_cap
 * (the scope's vector rows are full), graph_capacity (the scope's graph reached its entity limit).
 */
export type BrainRefreshStopReason = "embedding_unavailable" | "vector_cap" | "graph_capacity";

/** stopReason: present only when the refresh is stuck (see BrainRefreshStopReason); progress made before it stays. */
export interface BrainDerivedRefreshResult {
  readonly processed: number; readonly removed: number; readonly caughtUp: boolean;
  readonly stopReason?: BrainRefreshStopReason;
  /** Search with meaning search on only. */
  readonly embedding?: BrainRefreshEmbeddingView;
}

/** pendingDocuments counts live documents missing or outdated in the index, capped at BRAIN_INDEX_PENDING_COUNT_CAP. */
export interface BrainIndexFreshness {
  readonly caughtUp: boolean; readonly pendingDocuments: number; readonly pendingCapped: boolean;
}
export const BRAIN_INDEX_PENDING_COUNT_CAP = 1_000;

/**
 * A derived index over the core tables. Rows are keyed by document and record the (incarnation, revision) they were
 * built from; per-document rows reference brain_documents (owner_id, scope_id, document_id) ON DELETE CASCADE, so
 * eraseScope removes them; scope-level rows go on scope_erased. A write that hits a foreign-key violation (the
 * document was erased meanwhile) is a skipped document, not an error.
 */
export interface BrainDerivedIndex extends BrainChangeListener {
  refresh(
    scope: BrainScopeKey, limits: Partial<BrainDerivedRefreshLimits>, signal: AbortSignal,
  ): Promise<BrainDerivedRefreshResult>;
  freshness(scope: BrainScopeKey): Promise<BrainIndexFreshness>;
}

/** Tokens and micro-USD one search refresh spent on embeddings, and why its embedding pass stopped early. */
export interface BrainRefreshEmbeddingView {
  readonly tokens: number; readonly costMicroUsd: number;
  /** budget: the per-refresh token or cost budget; vector_cap: the scope's array rows are full; null: not early. */
  readonly stopped: "budget" | "vector_cap" | null;
}

/** POST /search/refresh and POST /graph/refresh answer with one bounded refresh. */
export interface BrainRefreshView extends BrainDerivedRefreshResult {
  readonly index: "search" | "graph";
  readonly freshness: BrainIndexFreshness;
}
export const BRAIN_REFRESH_BODY_MAX_BYTES = 1_024;

// Bootstrap.

/**
 * Each feature exports one idempotent bootstrap (CREATE ... IF NOT EXISTS under its BRAIN_FEATURE_SCHEMA_LOCKS lock,
 * `SET LOCAL lock_timeout = '5s'` and `statement_timeout = '30s'`), creating only its own prefixed tables. Called by
 * startBrainServices (api/start.ts) after the core bootstrap, in BRAIN_BOOTSTRAP_ORDER. Each feature bootstrap runs on
 * its own; a failure of any kind leaves only that feature off (its routes 503, its tools dropped). The core bootstrap
 * alone defers the whole brain. Future changes: ADD COLUMN IF NOT EXISTS.
 */
export type BrainFeatureBootstrap<TResult = void> = (db: Kysely<BrainDatabase>) => Promise<TResult>;
export const BRAIN_BOOTSTRAP_ORDER = [
  "core", "search", "graph", "github", "matrix_sources", "connectors", "brief", "jobs",
] as const satisfies readonly (BrainFeature | "core")[];

// Background work.

/** Scopes with at least one live source, for scheduled work; read-only over brain_sources. */
export interface BrainScopeLister {
  listActiveScopes(ownerId: string, limit: number): Promise<readonly BrainScopeKey[]>;
}
export const BRAIN_SCHEDULED_SCOPES_MAX = 200;

/**
 * A timer owned by a feature (the brief scheduler, the index catch-up, the background run worker): start() is
 * idempotent and arms an unref'd timer; stop() clears it and waits for running work up to its own deadline. Started
 * after the server listens, stopped on gateway shutdown before the owner Kysely is destroyed; the run worker
 * (jobs/worker.ts, named "brain-jobs") stops first, because its steps call the other services.
 */
export interface BrainBackgroundJob {
  readonly name: string;
  start(): void;
  stop(): Promise<void>;
}
