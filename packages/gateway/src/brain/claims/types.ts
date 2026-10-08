/**
 * Company Brain claims: the contract shared by the claim tables, store, extractors, job and API. Limits are mirrored by
 * the SQL CHECKs (database.ts) and Zod schemas (here, schemas.ts). Offsets are UTF-16 code units into the stored body:
 * `body.slice(spanStart, spanEnd) === quote` holds for every stored claim.
 */
import { createHash } from "node:crypto";
import type { ColumnType, Generated } from "kysely";
import { z } from "zod/v4";
import type { BrainDocument, BrainRefMatchMode, BrainScopeKey } from "../types.js";
import type { BrainClaimModelOutcome } from "./model/types.js";

type Timestamp = ColumnType<Date | string, Date | string, Date | string>;
type NullableTimestamp = ColumnType<Date | string | null, Date | string | null, Date | string | null>;
/** JSONB: written as sql`${JSON.stringify(value)}::jsonb`, read back as a parsed value. */
type JsonValue = ColumnType<unknown, unknown, unknown>;

// Vocabularies and identifiers.

export const BRAIN_CLAIM_KINDS = ["invariant", "decision", "commitment", "risk"] as const;
export type BrainClaimKind = (typeof BRAIN_CLAIM_KINDS)[number];
export const BRAIN_CLAIM_CONFIDENCES = ["high", "medium", "low"] as const;
export type BrainClaimConfidence = (typeof BRAIN_CLAIM_CONFIDENCES)[number];
/**
 * A missing state row, or one for an older incarnation or revision, also reads as pending; so does a document whose
 * only rules state is of another rules version.
 */
export type BrainExtractionStatus = "pending" | "done" | "failed" | "skipped";
export type BrainExtractionRunStatus = "running" | "succeeded" | "partial" | "failed" | "interrupted";
/** Terminal statuses a caller may close a run with. */
export type BrainExtractionRunOutcome = "succeeded" | "partial" | "failed";

export const BRAIN_CLAIM_ID_PATTERN = /^[a-f0-9]{64}$/;
export const BRAIN_EXTRACTION_RUN_ID_PATTERN = /^xrn_[a-f0-9]{32}$/;
/**
 * The rules extractor's version. Raise it whenever rules.ts decides differently: every live document is then pending
 * again, and the first write of the new version for a document removes that document's claims and state of every
 * other rules version in the same transaction (store.ts), so one document never holds two rules generations.
 * v2: fewer decisions under design-note sub-headings; open questions and open decisions are never claims.
 */
export const BRAIN_RULES_VERSION = 2;
/** Every rules extractor id starts with this; model ids start with `model:`. */
export const BRAIN_RULES_EXTRACTOR_PREFIX = "rules/";
export const BRAIN_RULES_EXTRACTOR_ID = `${BRAIN_RULES_EXTRACTOR_PREFIX}v${BRAIN_RULES_VERSION}`;
export const isBrainRulesExtractorId = (extractor: string): boolean =>
  extractor.startsWith(BRAIN_RULES_EXTRACTOR_PREFIX);
/** `rules/v<N>` or `model:<model-id>/<prompt-version>`; a model id may contain "/", the version is the last part. */
export const BRAIN_EXTRACTOR_ID_PATTERN =
  /^(?:rules\/v[1-9][0-9]{0,2}|model:[A-Za-z0-9@][A-Za-z0-9@._:/-]{0,94}\/[a-z0-9][a-z0-9._-]{0,23})$/;
export const BRAIN_EXTRACTOR_ID_MAX_CHARS = 128;

// Limits.

export const BRAIN_CLAIMS_PER_DOCUMENT_MAX = 50;
export const BRAIN_CLAIMS_PER_SCOPE_MAX = 50_000;
/** UTF-16 units. SQL checks char_length (code points), which is never larger. */
export const BRAIN_CLAIM_LABEL_MAX_CHARS = 80;
export const BRAIN_CLAIM_STATEMENT_MAX_CHARS = 1_000;
export const BRAIN_CLAIM_QUOTE_MAX_CHARS = 2_000;
/** A body is at most 65,536 utf8 bytes, so it has at most that many UTF-16 units. */
export const BRAIN_CLAIM_SPAN_MAX = 65_536;
/** Raw model candidates inspected per document; a longer array is model_output_invalid. */
export const BRAIN_MODEL_CANDIDATES_MAX = 200;
/** A running run older than this is closed as interrupted by the next openExtractionRun. */
export const BRAIN_EXTRACTION_RUN_LEASE_MS = 5 * 60_000;
/** Finished runs retained per scope, newest first; the running row is never pruned. */
export const BRAIN_EXTRACTION_RUNS_PER_SCOPE = 50;
/**
 * The scope id that keeps an erased scope's billed runs (cost above 0, started inside the spend window), so erasing a
 * project never erases the owner's model spend. No project scope has this id; its rows are pruned once they leave
 * the window, by the next run that opens in any scope of the owner.
 */
export const BRAIN_RETIRED_RUNS_SCOPE_ID = "brain:retired-runs";
/** In-process runs at once (one per scope key); a Set with this cap guards re-entry. */
export const BRAIN_EXTRACTION_MAX_CONCURRENT_RUNS = 16;
export const BRAIN_CLAIM_LIST_DEFAULT_LIMIT = 20;
export const BRAIN_CLAIM_LIST_MAX_LIMIT = 100;
/** base64url of JSON [at, documentId, spanStart, claimId, extractor]. */
export const BRAIN_CLAIM_LIST_CURSOR_MAX_CHARS = 640;
/** Characters of a git_pr or git_commit body tail returned with a claim; enough for the adapter footer. */
export const BRAIN_CLAIM_FOOTER_TAIL_CHARS = 2_048;
/** Mirrors GIT_PROVENANCE.pullRequest and .commit (the store must not import git/). */
export const BRAIN_CLAIM_FOOTER_PROVENANCES = ["git_pr", "git_commit"] as const;
/**
 * The only provenances a model extract request sends to a third-party model: documents synced from the owner's git
 * source (mirrors GIT_PROVENANCE). Chats, notes, files, calendar and other sources sharing a project scope never are.
 */
export const BRAIN_MODEL_PROVENANCES = ["git_pr", "git_commit", "git_spec"] as const;

/**
 * bodyBytesPerRun: utf8 bytes of bodies read per run (the first document is always read). maxAttempts: a failed
 * document is retried until it failed this often on one revision. tokensPerRun: input plus output tokens, checked
 * before each model call, so one call may overrun it. spendMicroUsdPer30d: model spend of the scope over the last 30
 * days (spend.ts), checked before each model call against that call's worst case; only a call whose usage never
 * reaches the run row (a timeout, an abort, or the call in flight when a run is lost) can pass it.
 */
export interface BrainExtractionLimits {
  readonly documentsPerRun: number; readonly bodyBytesPerRun: number; readonly runBudgetMs: number;
  readonly maxAttempts: number; readonly modelCallTimeoutMs: number; readonly tokensPerRun: number;
  readonly costMicroUsdPerRun: number; readonly spendMicroUsdPer30d: number;
}

export const BRAIN_EXTRACTION_DEFAULT_LIMITS: BrainExtractionLimits = {
  documentsPerRun: 100, bodyBytesPerRun: 4 * 1024 * 1024, runBudgetMs: 20_000, maxAttempts: 3,
  modelCallTimeoutMs: 60_000, tokensPerRun: 250_000, costMicroUsdPerRun: 1_000_000, spendMicroUsdPer30d: 5_000_000,
};

export const BRAIN_EXTRACTION_LIMIT_CEILINGS: BrainExtractionLimits = {
  documentsPerRun: 500, bodyBytesPerRun: 16 * 1024 * 1024, runBudgetMs: 120_000, maxAttempts: 10,
  modelCallTimeoutMs: 120_000, tokensPerRun: 2_000_000, costMicroUsdPerRun: 50_000_000,
  spendMicroUsdPer30d: 500_000_000,
};

/** The rolling window of the model spend cap. Runs that cost anything inside it are kept past the 50-run prune. */
export const BRAIN_MODEL_SPEND_WINDOW_MS = 30 * 24 * 60 * 60_000;
/** Runs that cost anything, per owner and window; at this count the cap stops new calls until the oldest ages out. */
export const BRAIN_MODEL_SPEND_BILLED_RUNS_MAX = 1_000;

// Codes. Every code matches BRAIN_ERROR_CODE_PATTERN.

/**
 * Run-level codes. The first four can end a run before a run row exists; then they are only returned. The model_*
 * codes after them come from a BrainModelError (model/types.ts). spend_cap_reached: the owner's 30-day model spend
 * cannot cover the next call (spend.ts).
 */
export type BrainExtractionErrorCode =
  | "invalid_options" | "model_not_configured" | "extraction_in_progress" | "store_unavailable"
  | "claims_capacity" | "run_superseded" | "model_usage_invalid" | "internal_error"
  | "model_auth_failed" | "model_unavailable" | "model_rejected" | "spend_cap_reached";

/**
 * Recorded on a document's extraction state with status failed or skipped (skips: BRAIN_MODEL_SKIP_CODES and
 * provenance_not_allowed).
 */
export type BrainExtractionDocumentErrorCode =
  | "extractor_error" | "model_failed" | "model_timeout" | "model_output_invalid" | "claim_invalid"
  | "document_too_large" | "model_refused" | "body_too_short" | "commit_list_only" | "provenance_not_allowed";

export type BrainExtractionNextAction =
  "" | "run_again" | "retry_later" | "raise_capacity" | "configure_model" | "contact_support" | "raise_budget";

// Kysely tables. Every row carries (owner_id, scope_id); every primary key starts with that pair.

/** revision: the document revision the claim was read from. */
export interface BrainClaimsTable {
  owner_id: string; scope_id: string; claim_id: string; extractor: string; document_id: string; incarnation: string;
  revision: number; kind: BrainClaimKind; label: string | null; statement: string; quote: string;
  span_start: number; span_end: number; fields: JsonValue; confidence: BrainClaimConfidence; created_at: Timestamp;
}

/** One row per (document, extractor); attempts count on this (incarnation, revision) and restart at 1. */
export interface BrainExtractionStateTable {
  owner_id: string; scope_id: string; document_id: string; extractor: string; incarnation: string; revision: number;
  status: BrainExtractionStatus; attempts: number; error_code: string | null; updated_at: Timestamp;
}

export interface BrainExtractionRunsTable {
  owner_id: string; scope_id: string; run_id: string; extractor: string; status: BrainExtractionRunStatus;
  documents_processed: Generated<number>; documents_failed: Generated<number>; claims_written: Generated<number>;
  claims_removed: Generated<number>; claims_rejected: Generated<number>; quotes_rejected: Generated<number>;
  input_tokens: Generated<number>; output_tokens: Generated<number>; cost_microusd: Generated<number>;
  cache_read_tokens: Generated<number>; cache_write_tokens: Generated<number>; next_action: Generated<string>;
  error_code: string | null; started_at: Timestamp; finished_at: NullableTimestamp;
}

/** brain/types.ts: `interface BrainDatabase extends BrainClaimTables`. */
export interface BrainClaimTables {
  brain_claims: BrainClaimsTable; brain_extraction_state: BrainExtractionStateTable;
  brain_extraction_runs: BrainExtractionRunsTable;
}
