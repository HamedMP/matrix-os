/**
 * The graph as a derived index (hook listener "graph"). A hook only nudges: correctness comes from refresh, which
 * removes rows of tombstoned documents, derives live documents that are missing, at another (incarnation, revision)
 * or whose refs or current decision claims changed, then sweeps entities nothing references. Every pass is bounded by a
 * document count, a wall-clock budget and the abort signal.
 */
import { sql, type Kysely } from "kysely";
import {
  BRAIN_DERIVED_REFRESH_CEILINGS, BRAIN_DERIVED_REFRESH_DEFAULTS, BRAIN_ENTITY_DISPLAY_NAME_MAX_CHARS,
  BRAIN_GRAPH_LIMITS, BRAIN_HOOK_DOCUMENT_IDS_MAX, BRAIN_HOOK_LISTENER_BUDGET_MS, BRAIN_INDEX_PENDING_COUNT_CAP,
  type BrainDerivedIndex, type BrainDerivedRefreshLimits, type BrainDerivedRefreshResult, type BrainIndexFreshness,
} from "../contracts.js";
import { BRAIN_PROJECT_SCOPE_PREFIX } from "../api/types.js";
import type { BrainScopeKey } from "../types.js";
import { cutText, isEntityKey, brainEntityId } from "./ids.js";
import {
  claimsDigestSql, deriveGraphDocument, refsDigestSql, withGraphLock, type BrainGraphCapacity,
} from "./store.js";
import { BRAIN_GRAPH_ORPHAN_SWEEP_MAX, type BrainGraphDatabase, type BrainGraphExecutor } from "./types.js";

export interface BrainGraphIndexDeps {
  readonly db: Kysely<BrainGraphDatabase>;
  readonly now: () => Date;
  /** Milliseconds clock for budgets; default Date.now. */
  readonly clock?: () => number;
  /** Entities per scope; may only lower BRAIN_GRAPH_LIMITS.entitiesPerScope. */
  readonly maxEntities?: number;
  /** The project's name for its entity (a project scope only); absent, null or failing: the project id stays. */
  readonly projectName?: (scope: BrainScopeKey) => Promise<string | null>;
}

const DOCUMENT_ID = /^[a-f0-9]{64}$/;
const GRAPH_TABLES = ["brain_graph_links", "brain_graph_state", "brain_graph_aliases", "brain_graph_entities"] as const;

function clampLimit(value: number | undefined, fallback: number, ceiling: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.min(ceiling, Math.max(1, Math.floor(value)));
}

/** A write that hit a foreign-key violation: the document was erased meanwhile. */
function isForeignKeyViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23503";
}

/** Tombstoned documents with a state row (any with graph rows has one), then live ones missing or outdated, by id. */
async function pendingIds(db: BrainGraphExecutor, scope: BrainScopeKey, limit: number): Promise<string[]> {
  const orphans = await sql<{ document_id: string }>`SELECT s.document_id FROM brain_graph_state s
    JOIN brain_documents d ON d.owner_id = s.owner_id AND d.scope_id = s.scope_id AND d.document_id = s.document_id
    WHERE s.owner_id = ${scope.ownerId} AND s.scope_id = ${scope.scopeId} AND d.deleted_at IS NOT NULL
    ORDER BY s.document_id LIMIT ${limit}`.execute(db);
  const missing = await sql<{ document_id: string }>`SELECT d.document_id FROM brain_documents d
    LEFT JOIN brain_graph_state s
      ON s.owner_id = d.owner_id AND s.scope_id = d.scope_id AND s.document_id = d.document_id
    WHERE d.owner_id = ${scope.ownerId} AND d.scope_id = ${scope.scopeId} AND d.deleted_at IS NULL
      AND (s.document_id IS NULL OR s.incarnation <> d.incarnation OR s.revision <> d.revision
        OR s.claims_digest <> ${claimsDigestSql("d")} OR s.refs_digest <> ${refsDigestSql("d")})
    ORDER BY d.document_id LIMIT ${limit}`.execute(db);
  return [...orphans.rows, ...missing.rows].map((row) => row.document_id).slice(0, limit);
}

/**
 * The project entity of a project scope (named after the project when its name is known, else its id; a known name
 * replaces a stored one that differs), then up to BRAIN_GRAPH_ORPHAN_SWEEP_MAX unreferenced entities removed.
 */
async function sweepEntities(
  trx: BrainGraphExecutor, scope: BrainScopeKey, now: Date, projectName: string | null,
): Promise<number> {
  const projectId = scope.scopeId.slice(BRAIN_PROJECT_SCOPE_PREFIX.length);
  if (scope.scopeId.startsWith(BRAIN_PROJECT_SCOPE_PREFIX) && isEntityKey("project", projectId)) {
    const name = projectName === null ? "" : cutText(projectName, BRAIN_ENTITY_DISPLAY_NAME_MAX_CHARS);
    const onConflict = name === "" ? sql`DO NOTHING` : sql`DO UPDATE SET display_name = excluded.display_name
      WHERE brain_graph_entities.display_name <> excluded.display_name`;
    await sql`INSERT INTO brain_graph_entities
        (owner_id, scope_id, entity_id, kind, key, display_name, document_id, first_seen_at, last_seen_at)
      VALUES (${scope.ownerId}, ${scope.scopeId}, ${brainEntityId("project", projectId)}, 'project', ${projectId},
        ${name === "" ? projectId : name}, NULL, ${now}, ${now})
      ON CONFLICT (owner_id, scope_id, entity_id) ${onConflict}`.execute(trx);
  }
  const scoped = sql`x.owner_id = e.owner_id AND x.scope_id = e.scope_id`;
  const result = await sql<{ entity_id: string }>`DELETE FROM brain_graph_entities WHERE owner_id = ${scope.ownerId}
    AND scope_id = ${scope.scopeId} AND entity_id IN (SELECT e.entity_id FROM brain_graph_entities e
      WHERE e.owner_id = ${scope.ownerId} AND e.scope_id = ${scope.scopeId} AND e.kind NOT IN ('project', 'document')
        AND NOT EXISTS (SELECT 1 FROM brain_graph_links x WHERE ${scoped} AND x.from_entity_id = e.entity_id)
        AND NOT EXISTS (SELECT 1 FROM brain_graph_links x WHERE ${scoped} AND x.to_entity_id = e.entity_id)
        AND NOT EXISTS (SELECT 1 FROM brain_graph_aliases x WHERE ${scoped} AND x.alias_entity_id = e.entity_id)
        AND NOT EXISTS (SELECT 1 FROM brain_graph_aliases x WHERE ${scoped} AND x.entity_id = e.entity_id)
        AND NOT (e.kind = 'file' AND EXISTS (SELECT 1 FROM brain_document_refs x WHERE ${scoped}
          AND x.kind = 'path' AND x.value = e.key))
        AND NOT (e.kind = 'folder' AND EXISTS (SELECT 1 FROM brain_document_refs x WHERE ${scoped}
          AND x.kind = 'path' AND x.value >= e.key || '/' AND x.value < e.key || '0'))
      LIMIT ${BRAIN_GRAPH_ORPHAN_SWEEP_MAX}) RETURNING entity_id`.execute(trx);
  return result.rows.length;
}

export function createBrainGraphIndex(deps: BrainGraphIndexDeps): BrainDerivedIndex {
  const { db, now } = deps;
  const clock = deps.clock ?? Date.now;

  async function capacityOf(scope: BrainScopeKey): Promise<BrainGraphCapacity> {
    const max = Math.min(deps.maxEntities ?? BRAIN_GRAPH_LIMITS.entitiesPerScope, BRAIN_GRAPH_LIMITS.entitiesPerScope);
    const result = await sql<{ n: number }>`SELECT count(*)::int AS n FROM (SELECT 1 FROM brain_graph_entities
      WHERE owner_id = ${scope.ownerId} AND scope_id = ${scope.scopeId} LIMIT ${max}) AS capped`.execute(db);
    return { remaining: max - Number(result.rows[0]!.n) };
  }

  /** Derives ids in order until done, aborted, out of budget or out of entity capacity. */
  async function run(scope: BrainScopeKey, ids: readonly string[], deadline: number, signal: AbortSignal) {
    const capacity = await capacityOf(scope);
    let processed = 0;
    let removed = 0;
    for (const id of ids) {
      if (signal.aborted || clock() >= deadline) return { processed, removed, stopped: true, full: false };
      let outcome: string;
      try {
        outcome = await withGraphLock(db, scope, (trx) => deriveGraphDocument(trx, scope, id, now(), capacity));
      } catch (error: unknown) {
        if (!isForeignKeyViolation(error)) throw error;
        outcome = "skipped";
      }
      if (outcome === "capacity") {
        console.warn("[brain-graph] entity limit reached; derivation stopped");
        return { processed, removed, stopped: true, full: true };
      }
      if (outcome === "derived") processed += 1;
      if (outcome === "removed") removed += 1;
    }
    return { processed, removed, stopped: false, full: false };
  }

  /** A failed lookup (a deleted project, a lookup outage) keeps the stored name; logged by error name. */
  async function projectNameOf(scope: BrainScopeKey): Promise<string | null> {
    if (deps.projectName === undefined) return null;
    try {
      return await deps.projectName(scope);
    } catch (error: unknown) {
      console.warn("[brain-graph] project name unavailable:", error instanceof Error ? error.name : typeof error);
      return null;
    }
  }

  async function freshness(scope: BrainScopeKey): Promise<BrainIndexFreshness> {
    const pending = (await pendingIds(db, scope, BRAIN_INDEX_PENDING_COUNT_CAP + 1)).length;
    return {
      caughtUp: pending === 0, pendingDocuments: Math.min(pending, BRAIN_INDEX_PENDING_COUNT_CAP),
      pendingCapped: pending > BRAIN_INDEX_PENDING_COUNT_CAP,
    };
  }

  async function refresh(
    scope: BrainScopeKey, limits: Partial<BrainDerivedRefreshLimits>, signal: AbortSignal,
  ): Promise<BrainDerivedRefreshResult> {
    const documents = clampLimit(limits.documents, BRAIN_DERIVED_REFRESH_DEFAULTS.documents,
      BRAIN_DERIVED_REFRESH_CEILINGS.documents);
    const budgetMs = clampLimit(limits.budgetMs, BRAIN_DERIVED_REFRESH_DEFAULTS.budgetMs,
      BRAIN_DERIVED_REFRESH_CEILINGS.budgetMs);
    const deadline = clock() + budgetMs;
    let [processed, removed, attempted] = [0, 0, 0];
    // Derivation marks dependents outdated, so pending is re-read until empty or the limit is spent.
    for (let ids = await pendingIds(db, scope, documents); ids.length > 0;
      ids = attempted < documents ? await pendingIds(db, scope, documents - attempted) : []) {
      const pass = await run(scope, ids, deadline, signal);
      [processed, removed, attempted] = [processed + pass.processed, removed + pass.removed, attempted + ids.length];
      if (pass.full) return { processed, removed, caughtUp: false, stopReason: "graph_capacity" };
      if (pass.stopped) return { processed, removed, caughtUp: false };
    }
    const name = await projectNameOf(scope);
    const swept = await withGraphLock(db, scope, (trx) => sweepEntities(trx, scope, now(), name));
    return { processed, removed, caughtUp: swept < BRAIN_GRAPH_ORPHAN_SWEEP_MAX && (await freshness(scope)).caughtUp };
  }

  return {
    name: "graph",
    async handle(event, signal) {
      if (event.type === "scope_erased") {
        await withGraphLock(db, event.scope, async (trx) => {
          for (const table of GRAPH_TABLES) {
            await trx.deleteFrom(table).where("owner_id", "=", event.scope.ownerId)
              .where("scope_id", "=", event.scope.scopeId).execute();
          }
        });
      } else if (event.documentIds === null) {
        await refresh(event.scope, {}, signal);
      } else {
        const ids = [...new Set(event.documentIds)].filter((id) => DOCUMENT_ID.test(id));
        const deadline = clock() + BRAIN_HOOK_LISTENER_BUDGET_MS;
        await run(event.scope, ids.slice(0, BRAIN_HOOK_DOCUMENT_IDS_MAX), deadline, signal);
      }
    },
    refresh,
    freshness,
  };
}
