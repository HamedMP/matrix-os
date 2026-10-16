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

function earlyResult(code: GitSyncErrorCode): GitSyncResult {
  return {
    status: "failed", errorCode: code, nextAction: NEXT_ACTIONS[code], receipt: null, counts: ZERO_COUNTS,
    cursorBefore: null, cursorAfter: null, commitsProcessed: 0, commitsRemaining: 0, caughtUp: false,
    historyRewritten: false, batches: 0, rejectedDocumentIds: [], notices: [],
  };
}

function resolveLimits(partial: Partial<GitSyncLimits> | undefined): GitSyncLimits {
  const limits: Record<keyof GitSyncLimits, number> = { ...GIT_SYNC_DEFAULT_LIMITS };
  for (const key of LIMIT_KEYS) {
    limits[key] = Math.min(partial?.[key] ?? GIT_SYNC_DEFAULT_LIMITS[key], GIT_SYNC_LIMIT_CEILINGS[key]);
  }
  return limits;
}

/** Null when the options are invalid (never recorded on a receipt). */
function parseOptions(options: GitSyncOptions): SyncRun | null {
  const parsed = GitSyncOptionsSchema.safeParse({
    scope: options.scope, sourceId: options.sourceId, repoPath: options.repoPath,
    homePath: options.homePath, config: options.config, limits: options.limits,
  });
  if (!parsed.success) return null;
  if (options.runner !== undefined && typeof options.runner !== "function") return null;
  if (options.now !== undefined && typeof options.now !== "function") return null;
  // The schema already checked every glob and the 1..8 count, so this cannot throw invalid_options.
  const matcher = compileSpecGlobs(parsed.data.config?.specGlobs ?? GIT_DEFAULT_SPEC_GLOBS);
  return {
    repository: options.repository, scope: parsed.data.scope, sourceId: parsed.data.sourceId,
    repoPath: parsed.data.repoPath, homePath: parsed.data.homePath, branch: parsed.data.config?.branch ?? null,
    matcher, runner: options.runner ?? defaultGitRunner, limits: resolveLimits(parsed.data.limits),
    now: options.now ?? Date.now,
  };
}

interface OpenedRun { readonly source: BrainSource; readonly receipt: BrainSyncReceipt }

/** Pre-receipt checks; a code here is returned, never recorded. */
async function openRun(run: SyncRun): Promise<OpenedRun | GitSyncErrorCode> {
  try {
    const source = await storeCall(() => run.repository.getSource(run.scope, run.sourceId));
    if (source === null || source.deletedAt !== null) return "source_unavailable";
    if (source.kind !== GIT_SOURCE_KIND) return "source_kind_mismatch";
    if (source.status !== "active") return "source_inactive";
    const receipt = await storeCall(() => run.repository.openSyncReceipt(run.scope, { sourceId: run.sourceId }));
    return { source, receipt };
  } catch (error) {
    if (error instanceof BrainStoreError && error.code === "conflict") return "source_inactive";
    return errorCodeOf(error);
  }
}

interface WindowRun {
  readonly repo: GitRepository;
  readonly ctx: GitDocumentContext;
  readonly tip: string;
  readonly receiptId: string;
}

/**
 * One window: commit documents (newest wins per id), final spec parts, then
 * batches. Non-final batches hold the cursor at this run's in-progress token;
 * only the final batch moves it to the window end.
 */
async function applyWindow(
  run: SyncRun,
  window: WindowRun,
  range: { readonly from: string | null; readonly to: string },
  commits: readonly GitCommitRecord[],
  progress: RunProgress,
): Promise<void> {
  const documents = new Map<string, GitUpsertDraft>();
  for (const commit of commits) {
    const built = buildCommitDocument(commit, window.ctx);
    progress.addNotices(built.notices);
    documents.delete(built.draft.documentId);
    documents.set(built.draft.documentId, built.draft);
  }
  const specs = await buildWindowSpecs({
    repo: window.repo, ctx: window.ctx, commits, windowEnd: range.to, tip: window.tip,
    notice: (notice) => progress.notice(notice),
  });
  const plans = planWindowBatches([...documents.values(), ...specs.upserts], [...new Set(specs.deletions)], run.limits);
  const token = inProgressCursor(range.from, window.tip, window.receiptId);
  for (const plan of plans) {
    const expected = progress.cursor;
    const result = await storeCall(() => run.repository.applySyncBatch(run.scope, {
      sourceId: run.sourceId,
      expectedCursor: expected,
      nextCursor: plan.final ? appliedCursor(range.to, window.tip) : token,
      upserts: plan.upserts,
      deletions: plan.deletions,
    }));
    progress.recordBatch(plan, result);
  }
}

/** The cursor's position, and the tip its run worked toward, are both still on the way to this tip. */
async function cursorStillValid(repo: GitRepository, cursor: GitCursor, tipSha: string): Promise<boolean> {
  for (const sha of [cursor.tip, cursor.position]) {
    if (sha === null || sha === tipSha) continue;
    if (!repo.shaPattern.test(sha) || !(await repo.isAncestor(sha, tipSha))) return false;
  }
  return true;
}

/**
 * The exclusive lower bound of this run: the cursor's position, or the root
 * before the first window; undefined when already at the tip. Any other
 * cursor means rewritten history (a force-push, a garbage-collected object,
 * or commits a stopped run read ahead that are gone): rescan from the root.
 */
async function startingPoint(repo: GitRepository, progress: RunProgress, tipSha: string): Promise<string | null | undefined> {
  if (progress.cursor === null) return null;
  const cursor = parseGitCursor(progress.cursor);
  if (cursor !== null && await cursorStillValid(repo, cursor, tipSha)) {
    return cursor.position === tipSha ? undefined : cursor.position;
  }
  progress.rewritten = true;
  return null;
}

async function runWindows(run: SyncRun, opened: OpenedRun, progress: RunProgress): Promise<void> {
  const start = run.now();
  const stored = await storeCall(() => run.repository.getSyncCursor(run.scope, run.sourceId));
  progress.cursorBefore = stored?.cursor ?? null;
  progress.cursor = progress.cursorBefore;
  const repo = await openGitRepository({
    repoPath: run.repoPath, homePath: run.homePath, runner: run.runner, limits: run.limits,
  });
  const web = resolveGitWebBase({ externalRef: opened.source.externalRef, remoteUrl: await repo.readOriginUrl() });
  if (!web.ok) throw new GitSourceError(web.code);
  const tip = await repo.resolveTip(run.branch);
  const ctx: GitDocumentContext = { identity: opened.source.externalRef, webBase: web.webBase, matcher: run.matcher };
  const window: WindowRun = { repo, ctx, tip: tip.sha, receiptId: opened.receipt.receiptId };
  const begin = await startingPoint(repo, progress, tip.sha);
  if (begin === undefined) return;
  let from: string | null = begin;
  let rechecked = false;
  progress.remaining = await repo.countFirstParent({ from, to: tip.sha });
  while (progress.remaining > 0 && progress.processed < run.limits.commitsPerRun) {
    if (progress.processed > 0 && run.now() - start >= run.limits.runBudgetMs) {
      progress.notice("run_budget_exhausted");
      break;
    }
    const take = Math.min(progress.remaining, run.limits.commitsPerWindow, run.limits.commitsPerRun - progress.processed);
    const windowEnd: string = take === progress.remaining
      ? tip.sha
      : await repo.firstParentAt({ from, to: tip.sha }, progress.remaining - take);
    const commits = await repo.readCommits({ from, to: windowEnd }, { isSpecPath: (path) => run.matcher.matches(path) });
    if (commits.length !== take) throw new GitSourceError("git_output_malformed");
    if (from !== null && commits[0]!.parents[0] !== from) {
      // The cursor is an ancestor but not on the first-parent chain: rescan once from the root.
      if (rechecked) throw new GitSourceError("git_output_malformed");
      rechecked = true;
      progress.rewritten = true;
      from = null;
      progress.remaining = await repo.countFirstParent({ from: null, to: tip.sha });
      continue;
    }
    await applyWindow(run, window, { from, to: windowEnd }, commits, progress);
    progress.processed += take;
    progress.remaining -= take;
    from = windowEnd;
  }
}

/** A cursor CAS miss is a concurrent run unless the source stopped being active. */
async function conflictCode(run: SyncRun): Promise<GitSyncErrorCode> {
  try {
    const source = await run.repository.getSource(run.scope, run.sourceId);
    return source !== null && source.deletedAt === null && source.status === "active" ? "cursor_conflict" : "source_inactive";
  } catch (error) {
    logSyncError("source re-read failed", error, "cursor_conflict");
    return "cursor_conflict";
  }
}

/** Closing never throws; a receipt interrupted by a concurrent run or a source delete is logged and reported as null. */
async function closeReceipt(
  run: SyncRun,
  receipt: BrainSyncReceipt,
  close: {
    status: BrainSyncReceiptOutcome;
    counts: BrainSyncCounts;
    nextAction: GitSyncNextAction;
    errorCode: GitSyncErrorCode | GitSyncInfoCode | null;
  },
): Promise<BrainSyncReceipt | null> {
  try {
    return await run.repository.closeSyncReceipt(run.scope, { sourceId: run.sourceId, receiptId: receipt.receiptId, ...close });
  } catch (error) {
    logSyncError("receipt close failed", error);
    return null;
  }
}

async function finishRun(
  run: SyncRun,
  receipt: BrainSyncReceipt,
  progress: RunProgress,
  failure: GitSyncErrorCode | null,
): Promise<GitSyncResult> {
  if (progress.rewritten) progress.notice("history_rewritten");
  const counts = progress.counts();
  const status: BrainSyncReceiptOutcome = failure !== null ? "failed" : progress.rejectedCount > 0 ? "partial" : "succeeded";
  const errorCode = failure
    ?? (progress.rejectedCount > 0 ? "documents_rejected" : progress.rewritten ? "history_rewritten" : null);
  const nextAction: GitSyncNextAction = failure !== null ? NEXT_ACTIONS[failure] : progress.remaining > 0 ? "run_again" : "";
  const closed = await closeReceipt(run, receipt, { status, counts, nextAction, errorCode });
  const remaining = failure === null ? progress.remaining : 0;
  return {
    status, errorCode, nextAction, receipt: closed, counts,
    cursorBefore: progress.cursorBefore, cursorAfter: progress.cursor,
    commitsProcessed: progress.processed, commitsRemaining: remaining,
    caughtUp: failure === null && remaining === 0, historyRewritten: progress.rewritten,
    batches: progress.batches, rejectedDocumentIds: [...progress.rejectedIds], notices: [...progress.notices],
  };
}

async function syncWithReceipt(run: SyncRun): Promise<GitSyncResult> {
  const opened = await openRun(run);
  if (typeof opened === "string") return earlyResult(opened);
  const progress = new RunProgress();
  let failure: GitSyncErrorCode | null = null;
  try {
    await runWindows(run, opened, progress);
  } catch (error) {
    failure = error instanceof BrainStoreError && error.code === "conflict" ? await conflictCode(run) : errorCodeOf(error);
    console.warn("[brain-git] sync failed", { code: failure });
  }
  return finishRun(run, opened.receipt, progress, failure);
}

/**
 * Syncs one git source (brain_sources.kind "git") from the checkout at
 * repoPath into the store. Bounded per run by limits.commitsPerRun and
 * limits.runBudgetMs; a result with nextAction "run_again" has more history
 * to apply. Never rejects.
 */
export async function syncGitSource(options: GitSyncOptions): Promise<GitSyncResult> {
  try {
    const run = parseOptions(options);
    if (run === null) return earlyResult("invalid_options");
    const key = JSON.stringify([run.scope.ownerId, run.scope.scopeId, run.sourceId]);
    if (runningSyncs.has(key) || runningSyncs.size >= GIT_MAX_CONCURRENT_SYNCS) return earlyResult("sync_in_progress");
    runningSyncs.add(key);
    try {
      return await syncWithReceipt(run);
    } finally {
      runningSyncs.delete(key);
    }
  } catch (error) {
    logSyncError("sync crashed", error, "internal_error");
    return earlyResult("internal_error");
  }
}
