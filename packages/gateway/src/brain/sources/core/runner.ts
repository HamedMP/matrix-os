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

const LIMIT_KEYS = ["pagesPerRun", "upsertsPerPage", "refsPerPage", "runBudgetMs", "providerTimeoutMs"] as const;
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
