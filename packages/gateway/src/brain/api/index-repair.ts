/**
 * Repairs of the derived indexes that do not wait for a change event, which is only a nudge and can be lost (the
 * hooks are closed before the HTTP server, so a sync that commits during shutdown emits into a closed bus):
 * - createBrainIndexCatchUp: a one-shot job shortly after start. It lists the scopes that have or had a source
 *   (a removed source's tombstones still need dropping), newest change first, at most BRAIN_SCHEDULED_SCOPES_MAX,
 *   and runs one bounded refresh of each derived index whose freshness shows pending documents. One pass under a
 *   wall-clock budget; stop() aborts it and waits briefly. Timers are unref'd.
 * - purgeBrainRemovedSource: right after a source is removed, the listeners drop the derived rows of its tombstoned
 *   documents, whenever they were tombstoned (in id batches, under a budget), so person names, emails and text do not
 *   stay readable until the next refresh. Returns false when it could not finish; the caller then emits the change
 *   event.
 */
import { sql, type Kysely } from "kysely";
import {
  BRAIN_DERIVED_REFRESH_DEFAULTS, BRAIN_HOOK_DOCUMENT_IDS_MAX, BRAIN_SCHEDULED_SCOPES_MAX,
  type BrainBackgroundJob, type BrainChangeListener, type BrainDerivedIndex,
} from "../contracts.js";
import { withBrainRead } from "../bounded.js";
import type { BrainDatabase, BrainScopeKey, BrainSource } from "../index.js";

export const BRAIN_INDEX_CATCH_UP = {
  name: "brain-index-catch-up",
  /** Delay of the pass after start, so startup work finishes first. */
  startDelayMs: 30_000,
  /** Wall clock of the whole pass, over every scope and index. */
  passBudgetMs: 120_000,
  /** How long stop() waits for an aborted pass to settle. */
  stopWaitMs: 5_000,
} as const;

export const BRAIN_SOURCE_PURGE = {
  /** Tombstoned documents of the removed source dealt with at once (one listener call per batch). */
  batches: 10,
  /** Wall clock of the whole purge. */
  budgetMs: 15_000,
} as const;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** Scopes that have or had a source, newest change first; read-only and bounded. */
export async function listBrainSourceScopes(db: Kysely<BrainDatabase>, limit: number): Promise<BrainScopeKey[]> {
  const bounded = Math.max(1, Math.min(Math.trunc(limit) || 1, BRAIN_SCHEDULED_SCOPES_MAX));
  const { rows } = await withBrainRead(db, (trx) => sql<{ owner_id: string; scope_id: string }>`
    SELECT owner_id, scope_id FROM brain_sources GROUP BY owner_id, scope_id
    ORDER BY max(updated_at) DESC, owner_id, scope_id LIMIT ${bounded}`.execute(trx));
  return rows.map((row) => ({ ownerId: row.owner_id, scopeId: row.scope_id }));
}

/** One pass: a bounded refresh of every index that is behind, scope by scope. Never throws; failures are logged. */
export async function runBrainIndexCatchUp(
  db: Kysely<BrainDatabase>, indexes: readonly BrainDerivedIndex[], signal: AbortSignal,
): Promise<{ readonly scopes: number; readonly refreshed: number; readonly failed: number }> {
  let [scopes, refreshed, failed] = [0, 0, 0];
  let listed: BrainScopeKey[];
  try {
    listed = await listBrainSourceScopes(db, BRAIN_SCHEDULED_SCOPES_MAX);
  } catch (error: unknown) {
    console.error("[brain] index catch-up could not list scopes:", errorName(error));
    return { scopes, refreshed, failed: 1 };
  }
  for (const scope of listed) {
    if (signal.aborted) break;
    scopes += 1;
    for (const index of indexes) {
      if (signal.aborted) break;
      try {
        if ((await index.freshness(scope)).caughtUp) continue;
        await index.refresh(scope, BRAIN_DERIVED_REFRESH_DEFAULTS, signal);
        refreshed += 1;
      } catch (error: unknown) {
        failed += 1;
        if (!signal.aborted) console.error(`[brain] index catch-up of ${index.name} failed:`, errorName(error));
      }
    }
  }
  return { scopes, refreshed, failed };
}

export function createBrainIndexCatchUp(deps: {
  readonly db: Kysely<BrainDatabase>; readonly indexes: readonly BrainDerivedIndex[];
  /** Tests only: delay after start(); default BRAIN_INDEX_CATCH_UP.startDelayMs. */
  readonly startDelayMs?: number;
}): BrainBackgroundJob {
  let timer: NodeJS.Timeout | null = null;
  let controller: AbortController | null = null;
  let running: Promise<void> | null = null;
  let started = false;

  async function pass(): Promise<void> {
    controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(BRAIN_INDEX_CATCH_UP.passBudgetMs)]);
    try {
      const summary = await runBrainIndexCatchUp(deps.db, deps.indexes, signal);
      if (summary.failed > 0) console.error(`[brain] index catch-up finished with ${summary.failed} failures`);
    } finally {
      controller = null;
    }
  }

  return {
    name: BRAIN_INDEX_CATCH_UP.name,
    start() {
      if (started) return;
      started = true;
      timer = setTimeout(() => {
        timer = null;
        running = pass().finally(() => { running = null; });
      }, Math.max(0, deps.startDelayMs ?? BRAIN_INDEX_CATCH_UP.startDelayMs));
      timer.unref();
    },
    async stop() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      controller?.abort();
      const pending = running;
      if (pending === null) return;
      let wait: NodeJS.Timeout | undefined;
      await Promise.race([pending, new Promise<void>((resolve) => {
        wait = setTimeout(resolve, BRAIN_INDEX_CATCH_UP.stopWaitMs);
        wait.unref();
      })]);
      clearTimeout(wait);
    },
  };
}

/**
 * Drops the derived rows of every tombstoned document of `removed`: the ones its removal tombstoned and the ones
 * tombstoned before it, whose change event may have been lost. Their ids go in batches of BRAIN_HOOK_DOCUMENT_IDS_MAX,
 * each handed to every listener as documents_changed. True when every batch ran; false when the ids ran past the
 * batch cap, the budget ran out or a listener failed (logged by name).
 */
export async function purgeBrainRemovedSource(
  db: Kysely<BrainDatabase>, listeners: readonly BrainChangeListener[], scope: BrainScopeKey, removed: BrainSource,
): Promise<boolean> {
  if (listeners.length === 0) return true;
  const signal = AbortSignal.timeout(BRAIN_SOURCE_PURGE.budgetMs);
  const cap = BRAIN_HOOK_DOCUMENT_IDS_MAX * BRAIN_SOURCE_PURGE.batches;
  const removedAt = removed.deletedAt ?? removed.updatedAt;
  try {
    const { rows } = await withBrainRead(db, (trx) => sql<{ document_id: string }>`SELECT document_id
      FROM brain_documents WHERE owner_id = ${scope.ownerId} AND scope_id = ${scope.scopeId}
        AND source_id = ${removed.sourceId} AND deleted_at IS NOT NULL
      ORDER BY document_id LIMIT ${cap + 1}`.execute(trx));
    const ids = rows.slice(0, cap).map((row) => row.document_id);
    for (let at = 0; at < ids.length; at += BRAIN_HOOK_DOCUMENT_IDS_MAX) {
      const event = {
        type: "documents_changed", scope, sourceId: removed.sourceId,
        documentIds: ids.slice(at, at + BRAIN_HOOK_DOCUMENT_IDS_MAX), at: removedAt,
      } as const;
      for (const listener of listeners) {
        signal.throwIfAborted();
        await listener.handle(event, signal);
      }
    }
    return rows.length <= cap && !signal.aborted;
  } catch (error: unknown) {
    console.error("[brain] removed source purge stopped; the change event repairs it:", errorName(error));
    return false;
  }
}
