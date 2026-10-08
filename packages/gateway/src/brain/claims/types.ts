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

// Fields, model output and usage: verify.ts parses model output with these, claims/schemas.ts store input.

export const noNul = (value: string): boolean => !value.includes("\u0000");
export const noControl = (value: string): boolean => !/\p{Cc}/u.test(value);

/** due: YYYY-MM-DD, a real calendar date. At most 1 KiB as JSON. */
export const BrainClaimFieldsSchema = z.object({
  assignee: z.string().trim().min(1).max(120).refine(noControl)
    .refine((value) => value.isWellFormed()).optional(),
  due: z.iso.date().optional(),
  severity: z.enum(["low", "medium", "high"]).optional(),
}).strict().refine((fields) => Buffer.byteLength(JSON.stringify(fields), "utf8") <= 1_024);
export type BrainClaimFields = z.output<typeof BrainClaimFieldsSchema>;

/** One raw model claim. verify.ts also requires the kind to be one the call asked for. */
export const BrainClaimCandidateSchema = z.object({
  kind: z.enum(BRAIN_CLAIM_KINDS),
  label: z.string().trim().min(1).max(BRAIN_CLAIM_LABEL_MAX_CHARS).refine(noControl).nullable().optional(),
  statement: z.string().trim().min(1).max(BRAIN_CLAIM_STATEMENT_MAX_CHARS).refine(noNul),
  quote: z.string().trim().min(1).max(BRAIN_CLAIM_QUOTE_MAX_CHARS).refine(noNul),
  fields: BrainClaimFieldsSchema.optional(),
}).strict();

/**
 * Tokens or micro-USD reported by one model call; more than 10,000,000 is model_usage_invalid. inputTokens counts
 * every prompt token; the cache counts are the part of it read from or written to the prompt cache (default 0).
 */
const usageCount = z.number().int().min(0).max(10_000_000);
export const BrainExtractionUsageSchema = z.object({
  inputTokens: usageCount, outputTokens: usageCount, costMicroUsd: usageCount,
  cacheReadTokens: usageCount.default(0), cacheWriteTokens: usageCount.default(0),
}).strict();
export type BrainExtractionUsage = z.output<typeof BrainExtractionUsageSchema>;
/** What a model reports: the cache counts may be left out. */
export type BrainExtractionUsageInput = z.input<typeof BrainExtractionUsageSchema>;

// Claim ids.

/** NFC, whitespace runs collapsed to one space, trimmed, lowercased. */
export function normalizeBrainClaimText(text: string): string {
  return text.normalize("NFC").replace(/\s+/gu, " ").trim().toLowerCase();
}

/**
 * sha256 of ["brain_claim_v1", documentId, kind, normalized label or null, normalized statement]; never of spans or
 * the extractor, so a claim that a new rules version reads the same way keeps its id (`brain_claim_v1` is the recipe's
 * version, not the extractor's). Rows are keyed by (claim id, extractor).
 */
export function computeBrainClaimId(
  documentId: string, kind: BrainClaimKind, label: string | null, statement: string,
): string {
  const normalizedLabel = label === null ? null : normalizeBrainClaimText(label);
  const tuple = ["brain_claim_v1", documentId, kind, normalizedLabel, normalizeBrainClaimText(statement)];
  return createHash("sha256").update(JSON.stringify(tuple)).digest("hex");
}

export function brainModelExtractorId(modelId: string, promptVersion: string): string {
  return `model:${modelId}/${promptVersion}`;
}

// Claims.

/** A verified claim before its id: quote === text.slice(spanStart, spanEnd); the statement has no whitespace runs. */
export interface BrainClaimDraft {
  readonly kind: BrainClaimKind; readonly label: string | null; readonly statement: string; readonly quote: string;
  readonly spanStart: number; readonly spanEnd: number; readonly fields: BrainClaimFields;
  readonly confidence: BrainClaimConfidence;
}

/** What the store accepts: claimId must equal computeBrainClaimId(documentId, kind, label, statement). */
export interface BrainClaimInput extends BrainClaimDraft { readonly claimId: string }

/**
 * createdAt: when the claim id was first written for the document and extractor. stale: the live document's
 * incarnation or revision differs from the one the claim was read from.
 */
export interface BrainClaim extends BrainClaimInput {
  readonly documentId: string; readonly extractor: string; readonly incarnation: string; readonly revision: number;
  readonly createdAt: string; readonly stale: boolean;
}

/** The live document. bodyTail: the last BRAIN_CLAIM_FOOTER_TAIL_CHARS of a git_pr or git_commit body (its footer). */
export interface BrainClaimDocument {
  readonly documentId: string; readonly provenance: string; readonly title: string; readonly permalink: string;
  readonly revision: number; readonly sourceUpdatedAt: string; readonly bodyTail: string | null;
}

export interface BrainClaimListItem { readonly claim: BrainClaim; readonly document: BrainClaimDocument }

/** path: only claims of documents with a path ref equal to or under the value (refs-reads.ts valueMatches). */
export interface BrainClaimListQuery {
  readonly kind?: BrainClaimKind; readonly path?: { readonly value: string; readonly mode: BrainRefMatchMode };
  readonly limit?: number; readonly cursor?: string | null;
}

/** Live documents only; newest source_updated_at, then document id descending; then span_start, claim id, extractor. */
export interface BrainClaimPage { readonly items: readonly BrainClaimListItem[]; readonly nextCursor: string | null }

// Extraction state and runs.

/**
 * order: "oldest" (default, the rules extractor) or "newest" (the model extractor reads recent documents first).
 * provenances: only documents of these provenances; absent means every provenance. For a rules extractor, a document
 * that still has state of another rules version is pending even when this version is done.
 */
export interface BrainPendingExtractionQuery {
  readonly extractor: string; readonly limit: number; readonly maxAttempts: number;
  readonly order?: "oldest" | "newest"; readonly provenances?: readonly string[];
}

export interface BrainPendingExtraction {
  readonly documentId: string; readonly incarnation: string; readonly revision: number;
  readonly provenance: string; readonly byteCount: number; readonly sourceUpdatedAt: string;
}

/** By source_updated_at, then document id: ascending for order "oldest" (the default), descending for "newest". */
export interface BrainPendingExtractionPage {
  readonly items: readonly BrainPendingExtraction[]; readonly hasMore: boolean;
}

export type BrainDocumentExtractionOutcome =
  | { readonly status: "done"; readonly claims: readonly BrainClaimInput[] }
  | { readonly status: "failed" | "skipped"; readonly errorCode: BrainExtractionDocumentErrorCode };

/**
 * runId must name the scope's running run for the same extractor, else conflict. runCostMicroUsd: the run's cost so
 * far (default 0), saved on the run row in the same write, even for a stale document, and never lowered.
 */
export interface BrainApplyDocumentExtractionInput {
  readonly runId: string; readonly documentId: string; readonly incarnation: string; readonly revision: number;
  readonly extractor: string; readonly outcome: BrainDocumentExtractionOutcome; readonly runCostMicroUsd?: number;
}

/**
 * written: claim rows new for this extractor. removed: rows deleted, including, for a rules extractor, the document's
 * claims of every other rules version. stale: the live document is gone or no longer at (incarnation, revision);
 * nothing was written.
 */
export type BrainApplyDocumentExtractionResult =
  | { readonly applied: true; readonly written: number; readonly removed: number }
  | { readonly applied: false; readonly reason: "stale" };
