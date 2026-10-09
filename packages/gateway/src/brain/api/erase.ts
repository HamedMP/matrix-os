/**
 * Erasing a deleted project's Company Brain scope, whether or not the brain or any feature started on this boot: a
 * feature that failed to start, or a brain whose start was deferred, still left rows behind. The core rows go through
 * BrainRepository.eraseScope (documents, revisions, refs, claims, receipts, sources, and by cascade every
 * per-document feature row and every source config row); then every feature's scope-level rows go from each of its
 * tables that exists, one transaction per feature under that feature's own lock, and the scope's background runs
 * through BrainJobStore. A missing table, or an older one without owner_id and scope_id, holds nothing of the scope.
 * Any other failure throws, so the project deletion fails and is retried. The core rows go first, so work already
 * running for the scope (a hook, a job, a refresh) that writes after its feature's erase finds nothing to write from:
 * per-document rows need their document (a foreign key or a live check under the feature lock), the graph's project
 * entity needs a source row of the scope and a stored brief, even one that cites nothing, a source or document row.
 * A new source, extraction run or job needs its project to still resolve under the scope or job lock (the admit of
 * createSource, openExtractionRun and BrainJobStore.enqueue), so none follows.
 */
import { sql, type Kysely } from "kysely";
import { BRAIN_FEATURE_SCOPE_LOCK_PREFIXES } from "../contracts.js";
import { BrainRepository, type BrainDatabase, type BrainScopeKey } from "../index.js";
import { BrainJobStore } from "../jobs/store.js";
import { BRAIN_PROJECT_ID_PATTERN, brainProjectScope } from "./types.js";

/** The core tables BrainRepository.eraseScope clears; none present means the brain never started here. */
const CORE_TABLES = [
  "brain_sources", "brain_documents", "brain_document_revisions", "brain_document_refs", "brain_sync_cursors",
  "brain_sync_receipts", "brain_claims", "brain_extraction_state", "brain_extraction_runs",
] as const;

interface FeatureErase {
  readonly feature: "search" | "graph" | "brief";
  /** The second key of the feature's advisory lock (the first is hashtext(ownerId)). */
  lockName(scope: BrainScopeKey): string;
  /** Children first. */
  readonly tables: readonly string[];
}

/** Every feature table with scope-level rows (no document or source foreign key), per feature lock. */
export const BRAIN_FEATURE_ERASE_TABLES: readonly FeatureErase[] = [
  {
    feature: "search", lockName: (scope) => `${BRAIN_FEATURE_SCOPE_LOCK_PREFIXES.search}${scope.scopeId}`,
    tables: ["brain_search_chunks", "brain_search_vectors", "brain_search_claims", "brain_search_documents"],
  },
  {
    feature: "graph", lockName: (scope) => `${BRAIN_FEATURE_SCOPE_LOCK_PREFIXES.graph}${scope.scopeId}`,
    tables: ["brain_graph_links", "brain_graph_state", "brain_graph_aliases", "brain_graph_entities"],
  },
  {
    feature: "brief", lockName: (scope) => `${BRAIN_FEATURE_SCOPE_LOCK_PREFIXES.brief}${scope.scopeId}`,
    tables: ["brain_brief_briefs"],
  },
];

/** Which of `tables` exist in the current schema with both owner_id and scope_id: only those can hold scope rows. */
async function erasableTables(db: Kysely<BrainDatabase>, tables: readonly string[]): Promise<Set<string>> {
  const { rows } = await sql<{ name: string }>`SELECT c.table_name AS name FROM information_schema.columns c
    WHERE c.table_schema = current_schema() AND c.table_name IN (${sql.join([...tables])})
      AND c.column_name IN ('owner_id', 'scope_id')
    GROUP BY c.table_name HAVING count(DISTINCT c.column_name) = 2`.execute(db);
  return new Set(rows.map((row) => row.name));
}

/**
 * Erases one scope's core rows and every feature's rows of it; throws on any failure. A table that is missing, or an
 * unrelated older table without owner_id and scope_id, holds no rows of the scope and is passed over; core tables
 * only partly in that state are a damaged schema, refused rather than half erased.
 */
export async function eraseBrainScopeRows(db: Kysely<BrainDatabase>, scope: BrainScopeKey): Promise<void> {
  const present = await erasableTables(db, [
    ...CORE_TABLES, ...BRAIN_FEATURE_ERASE_TABLES.flatMap((erase) => erase.tables), "brain_jobs",
  ]);
  const core = CORE_TABLES.filter((table) => present.has(table)).length;
  if (core > 0 && core < CORE_TABLES.length) throw new Error("Company Brain core tables are incomplete");
  if (core > 0) await new BrainRepository(db).eraseScope(scope);
  for (const erase of BRAIN_FEATURE_ERASE_TABLES) {
    const tables = erase.tables.filter((table) => present.has(table));
    if (tables.length === 0) continue;
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
      await sql`SET LOCAL statement_timeout = '15s'`.execute(trx);
      await sql`SELECT pg_advisory_xact_lock(hashtext(${scope.ownerId}), hashtext(${erase.lockName(scope)}))`
        .execute(trx);
      for (const table of tables) {
        await sql`DELETE FROM ${sql.table(table)} WHERE owner_id = ${scope.ownerId} AND scope_id = ${scope.scopeId}`
          .execute(trx);
      }
    });
  }
  if (present.has("brain_jobs")) await new BrainJobStore(db).eraseScope(scope);
}

/** The project's scope erased (see eraseBrainScopeRows); a malformed project id is a no-op. Throws on failure. */
export async function eraseBrainProject(db: Kysely<BrainDatabase>, ownerId: string, projectId: string): Promise<void> {
  if (!BRAIN_PROJECT_ID_PATTERN.test(projectId)) return;
  await eraseBrainScopeRows(db, brainProjectScope(ownerId, projectId));
}

/**
 * The project deletion step, whatever state the brain is in: with the brain on, its eraseProject; with it off or
 * deferred but the owner database up, the same erase straight on the owner database; with an owner database
 * configured but not running, a throw, so the deletion fails and startup recovery retries it; with no owner database
 * configured there is no brain and nothing to erase.
 */
export function createBrainProjectCleanup(deps: {
  readonly databaseConfigured: boolean;
  readonly db: Kysely<BrainDatabase> | null;
  readonly services: { eraseProject(ownerId: string, projectId: string): Promise<void> } | null;
}): (ownerId: string, projectId: string) => Promise<void> {
  return async (ownerId, projectId) => {
    if (deps.services !== null) return deps.services.eraseProject(ownerId, projectId);
    if (deps.db !== null) return eraseBrainProject(deps.db, ownerId, projectId);
    if (deps.databaseConfigured) throw new Error("Project brain cleanup unavailable");
  };
}
