/**
 * runBrainSourceSync: the shared sync runner for every connectable source kind, generalized from git/sync.ts. One
 * bounded run: parse options, require the live active source of the adapter's kind, take the capped in-process
 * guard, open a receipt, then read pages until the adapter is caught up, the page cap or the run budget is reached.
 * The budget is checked only between pages, so a started page finishes; its signal aborts only when the caller
 * aborts or at the per-page ceiling (BRAIN_SOURCE_SYNC_LIMIT_CEILINGS.runBudgetMs, then provider_timeout). Each page
 * is one applySyncBatch that moves the cursor from the value it was read with (compare-and-set), followed by a
 * documents_changed hook. It never rejects; failures are stable codes on the result and the receipt.
 */
import { z } from "zod/v4";
import {
  BRAIN_SOURCE_KIND_PROVENANCES, BRAIN_SOURCE_MAX_CONCURRENT_SYNCS, BRAIN_SOURCE_NEXT_ACTIONS, BRAIN_SOURCE_NOTICES_MAX,
  BRAIN_SOURCE_REJECTED_IDS_MAX, BRAIN_SOURCE_SYNC_DEFAULT_LIMITS, BRAIN_SOURCE_SYNC_LIMIT_CEILINGS,
  type BrainSourceErrorCode, type BrainSourceNotice, type BrainSourcePage, type BrainSourceSyncLimits,
  type BrainSourceSyncOptions, type BrainSourceSyncResult, type BrainSourceSyncRunner,
} from "../../contracts.js";
import { BrainScopeKeySchema, BrainSourceIdSchema } from "../../schemas.js";
import {
  BRAIN_SYNC_BATCH_MAX_ITEMS, BRAIN_SYNC_BATCH_MAX_REFS, BrainStoreError, type BrainSyncCounts, type BrainSyncReceipt,
} from "../../types.js";

const LIMIT_KEYS = ["pagesPerRun", "upsertsPerPage", "refsPerPage", "runBudgetMs"] as const;
const limitValue = z.number().int().min(1).optional();
const OptionsSchema = z.object({
  scope: BrainScopeKeySchema,
  sourceId: BrainSourceIdSchema,
  limits: z.object(Object.fromEntries(LIMIT_KEYS.map((key) => [key, limitValue]))).strict().optional(),
}).strict();
const ZERO: BrainSyncCounts = { read: 0, written: 0, unchanged: 0, deleted: 0, failed: 0 };

/** One run per (owner, scope, source) in this process; capped; cleared in finally. */
const runningSyncs = new Set<string>();

class SyncFailure extends Error {
  constructor(readonly code: BrainSourceErrorCode, readonly retryAfterSeconds: number | null = null) {
    super("Brain source sync failed");
    this.name = "SyncFailure";
  }
}

function log(event: string, error: unknown, code?: string): void {
  console.warn(`[brain-sources] ${event}`, { code, ...(error instanceof Error ? { name: error.name } : {}) });
}

function resolveLimits(partial: Partial<BrainSourceSyncLimits> | undefined): BrainSourceSyncLimits {
  const limits = { ...BRAIN_SOURCE_SYNC_DEFAULT_LIMITS };
  for (const key of LIMIT_KEYS) {
    limits[key] = Math.min(partial?.[key] ?? BRAIN_SOURCE_SYNC_DEFAULT_LIMITS[key], BRAIN_SOURCE_SYNC_LIMIT_CEILINGS[key]);
  }
  return { ...limits, upsertsPerPage: Math.min(limits.upsertsPerPage, BRAIN_SYNC_BATCH_MAX_ITEMS),
    refsPerPage: Math.min(limits.refsPerPage, BRAIN_SYNC_BATCH_MAX_REFS) };
}

function early(code: BrainSourceErrorCode): BrainSourceSyncResult {
  return {
    status: "failed", errorCode: code, nextAction: BRAIN_SOURCE_NEXT_ACTIONS[code], receipt: null, counts: ZERO,
    caughtUp: false, pages: 0, skipped: 0, retryAfterSeconds: null, rejectedDocumentIds: [], notices: [],
  };
}

class Progress {
  cursor: string | null = null;
  pages = 0;
  skipped = 0;
  caughtUp = false;
  readonly rejected: string[] = [];
  rejectedCount = 0;
  readonly notices: BrainSourceNotice[] = [];
  readonly tally = { read: 0, written: 0, unchanged: 0, deleted: 0 };

  notice(values: readonly BrainSourceNotice[]): void {
    for (const notice of values) {
      if (!this.notices.includes(notice) && this.notices.length < BRAIN_SOURCE_NOTICES_MAX) this.notices.push(notice);
    }
  }

  counts(): BrainSyncCounts {
    return { ...this.tally, failed: this.rejectedCount };
  }
}

/** Store errors by meaning; a cursor or receipt conflict is a concurrent run unless the source stopped being active. */
async function storeFailure<TConfig>(options: BrainSourceSyncOptions<TConfig>, error: unknown): Promise<SyncFailure> {
  if (!(error instanceof BrainStoreError)) {
    log("store call failed", error, "store_unavailable");
    return new SyncFailure("store_unavailable");
  }
  if (error.code === "capacity") return new SyncFailure("brain_capacity");
  if (error.code === "not_found") return new SyncFailure("source_unavailable");
  if (error.code === "invalid") {
    log("store refused adapter output", error, "document_invalid");
    return new SyncFailure("document_invalid");
  }
  if (error.code !== "conflict") return new SyncFailure("internal_error");
  try {
    const source = await options.repository.getSource(options.scope, options.sourceId);
    return new SyncFailure(source !== null && source.status === "active" ? "cursor_conflict" : "source_inactive");
  } catch (reread) {
    log("source re-read failed", reread, "cursor_conflict");
    return new SyncFailure("cursor_conflict");
  }
}

function checkPage<TConfig>(options: BrainSourceSyncOptions<TConfig>, page: BrainSourcePage, limits: BrainSourceSyncLimits): void {
  const allowed: readonly string[] = BRAIN_SOURCE_KIND_PROVENANCES[options.adapter.kind];
  const refs = page.upserts.reduce((total, upsert) => total + (upsert.refs?.length ?? 0), 0);
  const valid = page.upserts.every((upsert) => allowed.includes(upsert.provenance))
    && page.upserts.length <= limits.upsertsPerPage && page.deletions.length <= BRAIN_SYNC_BATCH_MAX_ITEMS
    && (refs <= limits.refsPerPage || page.upserts.length === 1) && Number.isInteger(page.skipped) && page.skipped >= 0;
  if (!valid) {
    log("adapter page refused", null, "document_invalid");
    throw new SyncFailure("document_invalid");
  }
}

interface RunClock { readonly started: number; readonly now: () => number }

async function readPages<TConfig>(
  options: BrainSourceSyncOptions<TConfig>, limits: BrainSourceSyncLimits, progress: Progress, externalRef: string,
  clock: RunClock,
): Promise<void> {
  const { started, now } = clock;
  const repository = options.repository;
  while (!progress.caughtUp && progress.pages < limits.pagesPerRun) {
    if (progress.pages > 0 && (now() - started >= limits.runBudgetMs || options.signal?.aborted === true)) {
      progress.notice(["run_budget_exhausted"]);
      return;
    }
    const ceiling = AbortSignal.timeout(BRAIN_SOURCE_SYNC_LIMIT_CEILINGS.runBudgetMs);
    const signal = options.signal === undefined ? ceiling : AbortSignal.any([ceiling, options.signal]);
    const result = await options.adapter.readPage({
      scope: options.scope, sourceId: options.sourceId, externalRef, config: options.config,
      cursor: progress.cursor, signal, documents: repository, now: () => new Date(now()),
      limits: { maxUpserts: limits.upsertsPerPage, maxDeletions: BRAIN_SYNC_BATCH_MAX_ITEMS, maxRefs: limits.refsPerPage },
    }).catch((error: unknown) => {
      if (options.signal?.aborted === true) return null;
      if (ceiling.aborted) throw new SyncFailure("provider_timeout");
      throw error;
    });
    if (result === null) {
      progress.notice(["run_budget_exhausted"]);
      return;
    }
    if (!result.ok) throw new SyncFailure(result.code, result.code === "rate_limited" ? result.retryAfterSeconds ?? 60 : null);
    const page = result.page;
    checkPage(options, page, limits);
    progress.pages += 1;
    progress.skipped += page.skipped;
    progress.notice(page.notices);
    if (page.upserts.length > 0 || page.deletions.length > 0 || page.nextCursor !== progress.cursor) {
      const applied = await repository.applySyncBatch(options.scope, {
        sourceId: options.sourceId, expectedCursor: progress.cursor, nextCursor: page.nextCursor,
        upserts: page.upserts, deletions: page.deletions,
      }).catch(async (error: unknown) => { throw await storeFailure(options, error); });
      progress.cursor = applied.cursor.cursor;
      progress.tally.read += page.upserts.length + applied.deleted;
      progress.tally.written += applied.created + applied.updated;
      progress.tally.unchanged += applied.unchanged;
      progress.tally.deleted += applied.deleted;
      progress.rejectedCount += applied.rejected.length;
      for (const id of applied.rejected.slice(0, BRAIN_SOURCE_REJECTED_IDS_MAX - progress.rejected.length)) {
        progress.rejected.push(id);
      }
      const changed = applied.created + applied.updated + applied.refsChanged + applied.deleted;
      if (changed > 0 && options.hooks !== undefined) {
        // At most 200 upserts plus 200 deletions per page, under BRAIN_HOOK_DOCUMENT_IDS_MAX.
        const ids = [...page.upserts.map((upsert) => upsert.documentId), ...page.deletions];
        options.hooks.emit({
          type: "documents_changed", scope: options.scope, sourceId: options.sourceId,
          documentIds: ids, at: new Date(now()).toISOString(),
        });
      }
    }
    progress.caughtUp = page.caughtUp;
  }
}

async function closeReceipt<TConfig>(
  options: BrainSourceSyncOptions<TConfig>, receipt: BrainSyncReceipt, close: {
    status: "succeeded" | "partial" | "failed"; counts: BrainSyncCounts; nextAction: string; errorCode: string | null;
  },
): Promise<BrainSyncReceipt | null> {
  try {
    const input = { sourceId: options.sourceId, receiptId: receipt.receiptId, ...close };
    return await options.repository.closeSyncReceipt(options.scope, input);
  } catch (error) {
    log("receipt close failed", error);
    return null;
  }
}

async function runWithReceipt<TConfig>(
  options: BrainSourceSyncOptions<TConfig>, limits: BrainSourceSyncLimits,
): Promise<BrainSourceSyncResult> {
  let receipt: BrainSyncReceipt;
  let externalRef: string;
  try {
    const source = await options.repository.getSource(options.scope, options.sourceId);
    if (source === null || source.deletedAt !== null) return early("source_unavailable");
    if (source.kind !== options.adapter.kind) return early("source_kind_mismatch");
    if (source.status !== "active") return early("source_inactive");
    externalRef = source.externalRef;
    receipt = await options.repository.openSyncReceipt(options.scope, { sourceId: options.sourceId });
  } catch (error) {
    if (error instanceof BrainStoreError && error.code === "conflict") return early("source_inactive");
    return early((await storeFailure(options, error)).code);
  }
  const now = options.now ?? Date.now;
  const started = now();
  const progress = new Progress();
  let failure: SyncFailure | null = null;
  try {
    progress.cursor = (await options.repository.getSyncCursor(options.scope, options.sourceId)
      .catch(async (error: unknown) => { throw await storeFailure(options, error); }))?.cursor ?? null;
    await readPages(options, limits, progress, externalRef, { started, now });
  } catch (error) {
    failure = error instanceof SyncFailure ? error : new SyncFailure("internal_error");
    if (!(error instanceof SyncFailure)) log("adapter failed", error, "internal_error");
  }
  const counts = progress.counts();
  const status = failure !== null ? "failed" : progress.rejectedCount > 0 ? "partial" : "succeeded";
  const errorCode = failure?.code ?? (progress.rejectedCount > 0 ? "documents_rejected" : null);
  const nextAction = failure !== null ? BRAIN_SOURCE_NEXT_ACTIONS[failure.code] : progress.caughtUp ? "" : "run_again";
  const closed = await closeReceipt(options, receipt, { status, counts, nextAction, errorCode });
  return {
    status, errorCode, nextAction, receipt: closed, counts, caughtUp: failure === null && progress.caughtUp,
    pages: progress.pages, skipped: progress.skipped, retryAfterSeconds: failure?.retryAfterSeconds ?? null,
    rejectedDocumentIds: [...progress.rejected], notices: [...progress.notices],
  };
}

function validOptions<TConfig>(options: BrainSourceSyncOptions<TConfig>): boolean {
  const parsed = OptionsSchema.safeParse({ scope: options.scope, sourceId: options.sourceId, limits: options.limits });
  const adapter = options.adapter as Partial<BrainSourceSyncOptions<TConfig>["adapter"]> | undefined;
  const kind: unknown = adapter?.kind;
  return parsed.success && typeof adapter?.readPage === "function"
    && typeof kind === "string" && kind !== "git" && Object.hasOwn(BRAIN_SOURCE_KIND_PROVENANCES, kind)
    && typeof options.repository?.applySyncBatch === "function"
    && (options.now === undefined || typeof options.now === "function");
}

export const runBrainSourceSync: BrainSourceSyncRunner = async (options) => {
  try {
    if (!validOptions(options)) return early("invalid_options");
    const limits = resolveLimits(options.limits);
    const key = JSON.stringify([options.scope.ownerId, options.scope.scopeId, options.sourceId]);
    if (runningSyncs.has(key) || runningSyncs.size >= BRAIN_SOURCE_MAX_CONCURRENT_SYNCS) return early("sync_in_progress");
    runningSyncs.add(key);
    try {
      return await runWithReceipt(options, limits);
    } finally {
      runningSyncs.delete(key);
    }
  } catch (error) {
    log("sync crashed", error, "internal_error");
    return early("internal_error");
  }
};
