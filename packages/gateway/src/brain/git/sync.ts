/**
 * Git source adapter: syncGitSource() reads a checkout's first-parent history
 * oldest to newest in bounded windows and applies each window through
 * BrainRepository.applySyncBatch, moving the cursor (cursor.ts) in the same
 * transaction. It never rejects: every failure is a GitSyncResult with a
 * stable code, recorded on the sync receipt once one is open. Git stderr,
 * paths and driver text only reach server logs.
 */
import { isAbsolute } from "node:path";
import { z } from "zod/v4";
import { BrainScopeKeySchema, BrainSourceIdSchema, BrainStoreError } from "../index.js";
import type { BrainRepository } from "../repository.js";
import type {
  BrainScopeKey, BrainSource, BrainSyncBatchResult, BrainSyncCounts, BrainSyncReceipt, BrainSyncReceiptOutcome,
} from "../types.js";
import { planWindowBatches } from "./batches.js";
import { appliedCursor, inProgressCursor, parseGitCursor, type GitCursor } from "./cursor.js";
import { buildCommitDocument } from "./documents.js";
import { compileSpecGlobs, isSafeBranchName, isValidSpecGlob } from "./parse.js";
import { resolveGitWebBase } from "./permalinks.js";
import { defaultGitRunner, openGitRepository } from "./reader.js";
import {
  GIT_BRANCH_NAME_MAX_CHARS, GIT_DEFAULT_SPEC_GLOBS, GIT_MAX_CONCURRENT_SYNCS, GIT_MAX_REJECTED_IDS_IN_RESULT,
  GIT_MAX_SPEC_GLOBS, GIT_SOURCE_KIND, GIT_SPEC_GLOB_MAX_CHARS, GIT_SYNC_DEFAULT_LIMITS, GIT_SYNC_LIMIT_CEILINGS,
  GitSourceError,
  type GitBatchPlan, type GitCommitRecord, type GitDocumentContext, type GitRepository, type GitRunner,
  type GitSpecMatcher, type GitSyncErrorCode, type GitSyncInfoCode, type GitSyncLimits, type GitSyncNextAction,
  type GitSyncNotice, type GitSyncOptions, type GitSyncResult, type GitUpsertDraft,
} from "./types.js";
import { buildWindowSpecs } from "./window-specs.js";

const PATH_MAX_CHARS = 4_096;
const LIMIT_KEYS = [
  "commitsPerRun", "commitsPerWindow", "upsertsPerBatch", "refsPerBatch", "gitTimeoutMs", "runBudgetMs",
] as const satisfies readonly (keyof GitSyncLimits)[];

/** In-process re-entry guard, keyed by owner, scope and source; capped. Cross-process safety is the cursor CAS. */
const runningSyncs = new Set<string>();

const NEXT_ACTIONS: Readonly<Record<GitSyncErrorCode, GitSyncNextAction>> = {
  git_timeout: "retry_later", cursor_conflict: "retry_later", store_unavailable: "retry_later",
  sync_in_progress: "retry_later",
  not_a_repository: "fix_source", shallow_repository: "fix_source", branch_unavailable: "fix_source",
  web_base_unavailable: "fix_source", remote_mismatch: "fix_source", git_unavailable: "fix_source",
  git_version_unsupported: "fix_source", invalid_options: "fix_source", source_unavailable: "fix_source",
  source_inactive: "fix_source", source_kind_mismatch: "fix_source",
  brain_capacity: "raise_capacity",
  git_output_too_large: "contact_support", git_output_malformed: "contact_support",
  git_command_failed: "contact_support", document_invalid: "contact_support", internal_error: "contact_support",
};

const absolutePathSchema = z.string().min(1).max(PATH_MAX_CHARS)
  .refine((value) => !value.includes("\u0000") && isAbsolute(value));
const limitValueSchema = z.number().int().min(1).optional();

const GitSyncOptionsSchema = z.object({
  scope: BrainScopeKeySchema,
  sourceId: BrainSourceIdSchema,
  repoPath: absolutePathSchema,
  homePath: absolutePathSchema,
  config: z.object({
    branch: z.string().max(GIT_BRANCH_NAME_MAX_CHARS).refine((value) => isSafeBranchName(value)).nullable().optional(),
    specGlobs: z.array(z.string().max(GIT_SPEC_GLOB_MAX_CHARS).refine((value) => isValidSpecGlob(value)))
      .min(1).max(GIT_MAX_SPEC_GLOBS).optional(),
  }).strict().optional(),
  limits: z.object({
    commitsPerRun: limitValueSchema, commitsPerWindow: limitValueSchema, upsertsPerBatch: limitValueSchema,
    refsPerBatch: limitValueSchema, gitTimeoutMs: limitValueSchema, runBudgetMs: limitValueSchema,
  }).strict().optional(),
}).strict();

interface SyncRun {
  readonly repository: BrainRepository;
  readonly scope: BrainScopeKey;
  readonly sourceId: string;
  readonly repoPath: string;
  readonly homePath: string;
  readonly branch: string | null;
  readonly matcher: GitSpecMatcher;
  readonly runner: GitRunner;
  readonly limits: GitSyncLimits;
  readonly now: () => number;
}

class RunProgress {
  cursorBefore: string | null = null;
  /** The last cursor the store committed (or read at the start). */
  cursor: string | null = null;
  processed = 0;
  remaining = 0;
  rewritten = false;
  batches = 0;
  rejectedCount = 0;
  readonly rejectedIds: string[] = [];
  readonly notices: GitSyncNotice[] = [];
  private readonly tally = { read: 0, written: 0, unchanged: 0, deleted: 0 };

  notice(notice: GitSyncNotice): void {
    if (!this.notices.includes(notice)) this.notices.push(notice);
  }

  addNotices(notices: readonly GitSyncNotice[]): void {
    for (const notice of notices) this.notice(notice);
  }

  /** `read` counts upserts and the tombstones that hit a live document, so read = written + unchanged + deleted + failed. */
  recordBatch(plan: GitBatchPlan, result: BrainSyncBatchResult): void {
    this.cursor = result.cursor.cursor;
    this.batches += 1;
    this.tally.read += plan.upserts.length + result.deleted;
    this.tally.written += result.created + result.updated;
    this.tally.unchanged += result.unchanged;
    this.tally.deleted += result.deleted;
    this.rejectedCount += result.rejected.length;
    for (const documentId of result.rejected) {
      if (this.rejectedIds.length >= GIT_MAX_REJECTED_IDS_IN_RESULT) break;
      this.rejectedIds.push(documentId);
    }
  }

  counts(): BrainSyncCounts {
    return { ...this.tally, failed: this.rejectedCount };
  }
}

const ZERO_COUNTS: BrainSyncCounts = { read: 0, written: 0, unchanged: 0, deleted: 0, failed: 0 };

function describeError(error: unknown): { name: string; message: string } {
  return error instanceof Error ? { name: error.name, message: error.message } : { name: typeof error, message: "" };
}

function logSyncError(event: string, error: unknown, code?: GitSyncErrorCode): void {
  const cause = error instanceof Error && error.cause !== undefined ? describeError(error.cause) : undefined;
  console.warn(`[brain-git] ${event}`, { code, ...describeError(error), cause });
}

/** Store calls: any non-BrainStoreError (Postgres, driver) becomes store_unavailable. */
async function storeCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof BrainStoreError) throw error;
    throw new GitSourceError("store_unavailable", { cause: error });
  }
}

/**
 * reader.ts already maps runner failures to GitSourceError codes. A store
 * `conflict` never reaches here: openRun and syncWithReceipt map it first,
 * because what it means depends on the call that raised it.
 */
function errorCodeOf(error: unknown): GitSyncErrorCode {
  if (error instanceof GitSourceError) {
    if (error.code === "internal_error" || error.code === "store_unavailable") logSyncError("sync step failed", error, error.code);
    return error.code;
  }
  if (error instanceof BrainStoreError) {
    if (error.code === "capacity") return "brain_capacity";
    if (error.code === "not_found") return "source_unavailable";
    const code = error.code === "invalid" ? "document_invalid" : "internal_error";
    logSyncError(error.code === "invalid" ? "store rejected adapter input" : "store refused adapter call", error, code);
    return code;
  }
  logSyncError("unexpected sync failure", error, "internal_error");
  return "internal_error";
}
