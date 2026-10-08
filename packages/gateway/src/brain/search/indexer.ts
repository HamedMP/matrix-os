/**
 * The derived index and hook listener "search". refresh drops the chunks, then the rows (and array vectors), of
 * tombstoned documents; rebuilds outdated text rows in id order, a batch per transaction; then (meaning search on,
 * for a scope of an owner the provider serves) runs the embedding pass (embed-pass.ts) over rows that lack this
 * provider's vectors, never-tried first, of the provenances the owner allows at the refresh's start. Count, budget
 * and signal bound both passes. With meaning search on, the result also carries the pass's token use and cost, and a
 * pass that cannot go on (the provider failed, or the vector store is full) says so in stopReason. A pass that paid
 * is also logged (embed-pass.ts), since the hook listener and the index catch-up drop the result.
 */
import type { Kysely } from "kysely";
import {
  BRAIN_DERIVED_REFRESH_CEILINGS, BRAIN_DERIVED_REFRESH_DEFAULTS, BRAIN_HOOK_DOCUMENT_IDS_MAX,
  BRAIN_HOOK_LISTENER_BUDGET_MS, BRAIN_INDEX_PENDING_COUNT_CAP, type BrainDerivedIndex,
  type BrainDerivedRefreshLimits, type BrainDerivedRefreshResult, type BrainIndexFreshness, type BrainRefreshStopReason,
} from "../contracts.js";
import { BRAIN_DOCUMENT_ID_PATTERN, type BrainDatabase, type BrainScopeKey } from "../types.js";
import { brainCurrentEmbedTarget, runBrainEmbedPass, type BrainSearchMeaning } from "./embed-pass.js";
import {
  countPending, deleteOrphans, deleteScopeRows, rebuildDocuments, selectEmbedPending, selectOrphans,
  selectPendingIds, withSearchRead, withSearchScopeWrite, type BrainSearchOrphan,
} from "./index-sql.js";
import {
  BRAIN_SEARCH_REBUILD_BATCH, FOREIGN_KEY_VIOLATION, sqlState, type BrainSearchEmbeddingView,
  type BrainSearchEmbedTarget,
} from "./types.js";

/**
 * meaning: null unless a usable provider and a vector store both exist. ownerIds: the owners whose scopes the
 * provider may embed (absent: every owner); any other scope is indexed for text only.
 */
export interface BrainSearchIndexDeps {
  readonly db: Kysely<BrainDatabase>; readonly meaning: BrainSearchMeaning | null; readonly now: () => Date;
  readonly ownerIds?: readonly string[];
}

/** The meaning search a scope of this owner may use: null when off, or when the provider is not the owner's. */
export function brainMeaningFor(
  meaning: BrainSearchMeaning | null, ownerIds: readonly string[] | undefined, ownerId: string,
): BrainSearchMeaning | null {
  return meaning !== null && (ownerIds === undefined || ownerIds.includes(ownerId)) ? meaning : null;
}

/** The embed target of a scope, read now (brainCurrentEmbedTarget), or null without meaning search for it. */
export async function brainScopeEmbedTarget(
  meaning: BrainSearchMeaning | null, ownerIds: readonly string[] | undefined, scope: BrainScopeKey,
): Promise<BrainSearchEmbedTarget | null> {
  const active = brainMeaningFor(meaning, ownerIds, scope.ownerId);
  return active === null ? null : brainCurrentEmbedTarget(active);
}

function clamp(value: number | undefined, fallback: number, ceiling: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.min(ceiling, Math.max(1, Math.floor(value)));
}

/**
 * Pending documents of the scope (missing, outdated, sendable but not embedded under the target's marker, or
 * tombstoned with rows left), up to the count cap. A document the target may not send is never pending for vectors.
 */
export async function brainSearchFreshness(
  db: Kysely<BrainDatabase>, scope: BrainScopeKey, embed: BrainSearchEmbedTarget | null,
): Promise<BrainIndexFreshness> {
  const cap = BRAIN_INDEX_PENDING_COUNT_CAP;
  const count = await countPending(db, scope, embed, null, cap)
    + (await selectOrphans(db, scope, null, cap + 1)).length;
  return {
    caughtUp: count === 0, pendingDocuments: Math.min(count, BRAIN_INDEX_PENDING_COUNT_CAP),
    pendingCapped: count > BRAIN_INDEX_PENDING_COUNT_CAP,
  };
}

export function createBrainSearchIndex(deps: BrainSearchIndexDeps): BrainDerivedIndex {
  const { db, meaning } = deps;
  const read = <T>(fn: (trx: Kysely<BrainDatabase>) => Promise<T>): Promise<T> => withSearchRead(db, fn);

  /** One transaction per batch; a foreign-key refusal (a document erased meanwhile) retries one at a time. */
  async function rebuild(scope: BrainScopeKey, documentIds: readonly string[]): Promise<BrainSearchOrphan[]> {
    try {
      return await withSearchScopeWrite(db, scope, (trx) => rebuildDocuments(trx, scope, documentIds, deps.now()));
    } catch (error: unknown) {
      if (sqlState(error) !== FOREIGN_KEY_VIOLATION) throw error;
      if (documentIds.length === 1) return [];
      const built: BrainSearchOrphan[] = [];
      for (const documentId of documentIds) built.push(...await rebuild(scope, [documentId]));
      return built;
    }
  }

  /** Chunks go first: when that fails, the rows stay and the next refresh finds the orphans again. */
  async function sweep(scope: BrainScopeKey, ids: readonly string[] | null, limit: number): Promise<number> {
    const batch = await read((trx) => selectOrphans(trx, scope, ids, limit));
    if (batch.length === 0) return 0;
    if (meaning !== null) {
      for (const orphan of batch) {
        await meaning.vectors.replaceChunks(scope, { ...orphan, providerId: meaning.provider.providerId, chunks: [] });
      }
    }
    return withSearchScopeWrite(db, scope, (trx) => deleteOrphans(trx, scope, batch.map((orphan) => orphan.documentId)));
  }

  async function run(
    scope: BrainScopeKey, limits: Partial<BrainDerivedRefreshLimits>, signal: AbortSignal,
    ids: readonly string[] | null,
  ): Promise<BrainDerivedRefreshResult> {
    const documents = clamp(limits.documents, BRAIN_DERIVED_REFRESH_DEFAULTS.documents,
      BRAIN_DERIVED_REFRESH_CEILINGS.documents);
    const deadline = performance.now() + clamp(limits.budgetMs, BRAIN_DERIVED_REFRESH_DEFAULTS.budgetMs,
      BRAIN_DERIVED_REFRESH_CEILINGS.budgetMs);
    const halted = () => signal.aborted || performance.now() >= deadline;
    const active = brainMeaningFor(meaning, deps.ownerIds, scope.ownerId);
    const embed = active === null ? null : await brainCurrentEmbedTarget(active);
    const removed = await sweep(scope, ids, documents);
    const touched = new Set<string>();
    let stopped = false;
    const pending = await read((trx) => selectPendingIds(trx, scope, ids, documents));
    for (let at = 0; at < pending.length && !stopped; at += BRAIN_SEARCH_REBUILD_BATCH) {
      stopped = halted();
      const built = stopped ? [] : await rebuild(scope, pending.slice(at, at + BRAIN_SEARCH_REBUILD_BATCH));
      for (const row of built) touched.add(row.documentId);
    }
    const candidates = embed === null || stopped || pending.length >= documents ? [] : await read((trx) =>
      selectEmbedPending(trx, scope, embed, ids, documents - pending.length));
    let embedding: BrainSearchEmbeddingView = { tokens: 0, costMicroUsd: 0, stopped: null };
    let stopReason: BrainRefreshStopReason | null = null;
    if (candidates.length > 0) {
      const pass = await runBrainEmbedPass({
        db, scope, meaning: active!, target: embed!, now: deps.now, signal, halted, touched,
      }, candidates);
      ({ stopped, embedding } = pass);
      stopReason = pass.stopReason;
    }
    const caughtUp = !stopped && await read(async (trx) => await countPending(trx, scope, embed, ids, 0) === 0
      && (await selectOrphans(trx, scope, ids, 1)).length === 0);
    return {
      processed: touched.size, removed, caughtUp, ...(stopReason === null ? {} : { stopReason }),
      ...(active === null ? {} : { embedding }),
    };
  }

  return {
    name: "search",
    refresh: (scope, limits, signal) => run(scope, limits, signal, null),
    freshness: async (scope) => {
      const embed = await brainScopeEmbedTarget(meaning, deps.ownerIds, scope);
      return read((trx) => brainSearchFreshness(trx, scope, embed));
    },
    async handle(event, signal) {
      if (event.type === "scope_erased") {
        await withSearchScopeWrite(db, event.scope, (trx) => deleteScopeRows(trx, event.scope));
        return;
      }
      const known = event.documentIds !== null && event.documentIds.length <= BRAIN_HOOK_DOCUMENT_IDS_MAX
        ? event.documentIds.filter((id) => BRAIN_DOCUMENT_ID_PATTERN.test(id)) : null;
      if (known !== null && known.length === 0) return;
      await run(event.scope, { budgetMs: Math.min(BRAIN_DERIVED_REFRESH_DEFAULTS.budgetMs,
        BRAIN_HOOK_LISTENER_BUDGET_MS) }, signal, known);
    },
  };
}
