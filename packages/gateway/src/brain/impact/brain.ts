/**
 * Impact brief: what the brain already knows about the changed paths. Plain bounded SELECTs on the core tables (no
 * writes, no locks), all run by the caller in one bounded read (withBrainRead): the project's git source and its sync
 * position, the newest pull requests per changed path, the current invariant and decision claims of live documents
 * with a path ref equal to a changed path, and one git_spec document per touched spec folder. Path refs are exact
 * values, so `IN` lists of bound parameters suffice.
 * Earlier pull requests and claims come from documents dated at or before the merge base (`asOf`), so a range the
 * brain already synced never lists its own pull requests or decisions as history.
 */
import { sql, type Kysely, type SqlBool } from "kysely";
import { normalizeBrainClaimText } from "../claims/types.js";
import { loadBrainCites } from "../cite.js";
import type { BrainCiteView, BrainImpactClaim, BrainImpactPrior } from "../contracts.js";
import { parseGitCursor } from "../git/cursor.js";
import { selectCursor } from "../sync.js";
import type { BrainDatabase, BrainScopeKey } from "../types.js";

const PR_PROVENANCES = ["git_pr", "github_pr"];
/** Claim rows read per kind before de-duplication across extractors and repeated statements. */
const CLAIM_ROWS_PER_KIND = 200;
/** Changed paths listed per claim. */
export const IMPACT_CLAIM_PATHS_MAX = 20;

type Db = Kysely<BrainDatabase>;

/** The project's oldest live git source and the last first-parent commit its sync fully applied. */
export async function findGitSource(
  db: Db, scope: BrainScopeKey,
): Promise<{ readonly sourceId: string; readonly position: string | null } | null> {
  const git = await db.selectFrom("brain_sources").select("source_id")
    .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId).where("kind", "=", "git")
    .where("deleted_at", "is", null).orderBy("created_at").orderBy("source_id").limit(1).executeTakeFirst();
  if (git === undefined) return null;
  const cursor = await selectCursor(db, scope, git.source_id);
  const position = cursor === undefined ? null : parseGitCursor(cursor.cursor)?.position ?? null;
  return { sourceId: git.source_id, position };
}

/**
 * Up to perFile pull requests per path, newest first, one per label (a git_pr and a github_pr of the same number are
 * the same pull request); paths in input order, only those with at least one, at most maxFiles.
 */
export async function priorPullRequests(
  db: Db, scope: BrainScopeKey, paths: readonly string[], perFile: number, maxFiles: number, asOf: string,
): Promise<BrainImpactPrior[]> {
  if (paths.length === 0) return [];
  const values = sql.join(paths.map((path) => sql`(${path}::text)`));
  const { rows } = await sql<{ path: string; document_id: string }>`
    SELECT p.path, m.document_id FROM (VALUES ${values}) AS p(path) CROSS JOIN LATERAL (
      SELECT d.document_id, d.source_updated_at
      FROM brain_document_refs r
      JOIN brain_documents d ON d.owner_id = r.owner_id AND d.scope_id = r.scope_id AND d.document_id = r.document_id
      WHERE r.owner_id = ${scope.ownerId} AND r.scope_id = ${scope.scopeId} AND r.kind = 'path' AND r.value = p.path
        AND d.deleted_at IS NULL AND d.provenance IN (${sql.join(PR_PROVENANCES)})
        AND d.source_updated_at <= ${asOf}::timestamptz
      ORDER BY d.source_updated_at DESC, d.document_id DESC
      LIMIT ${perFile * 2}
    ) m`.execute(db);
  const cites = await loadBrainCites(db, scope, rows.map((row) => row.document_id));
  const byPath = new Map<string, BrainCiteView[]>();
  for (const row of rows) {
    const items = byPath.get(row.path) ?? [];
    const cite = cites.get(row.document_id);
    if (cite === undefined) continue;
    if (items.length < perFile && !items.some((item) => item.label === cite.label)) items.push(cite);
    byPath.set(row.path, items);
  }
  return paths.filter((path) => byPath.has(path)).slice(0, maxFiles)
    .map((path) => ({ path, items: byPath.get(path)! }));
}

/** Changed paths (bytewise order, at most IMPACT_CLAIM_PATHS_MAX) each document has a path ref for. */
async function touchedPaths(
  db: Db, scope: BrainScopeKey, ids: readonly string[], paths: readonly string[],
): Promise<Map<string, string[]>> {
  const ranked = db.selectFrom("brain_document_refs").select([
    "document_id", "value", sql<number>`row_number() OVER (PARTITION BY document_id ORDER BY value)`.as("n"),
  ]).where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId)
    .where("document_id", "in", [...ids]).where("kind", "=", "path").where("value", "in", [...paths]);
  const rows = await db.selectFrom(ranked.as("x")).select(["x.document_id", "x.value"])
    .where(sql<SqlBool>`${sql.ref("x.n")} <= ${IMPACT_CLAIM_PATHS_MAX}`)
    .orderBy("x.document_id").orderBy("x.value").execute();
  const byDocument = new Map(ids.map((id) => [id, [] as string[]]));
  for (const row of rows) byDocument.get(row.document_id)!.push(row.value);
  return byDocument;
}

/**
 * Current claims of one kind (claim revision and incarnation equal the live document's) whose document has a path ref
 * equal to one of `paths`; newest document first, then span. One per claim id and per normalized label and statement.
 */
export async function currentClaims(
  db: Db, scope: BrainScopeKey, paths: readonly string[], kind: BrainImpactClaim["kind"], max: number,
  asOf: string,
): Promise<BrainImpactClaim[]> {
  if (paths.length === 0) return [];
  const rows = await db.selectFrom("brain_claims as c")
    .innerJoin("brain_documents as d", (join) => join.onRef("d.owner_id", "=", "c.owner_id")
      .onRef("d.scope_id", "=", "c.scope_id").onRef("d.document_id", "=", "c.document_id"))
    .select(["c.claim_id", "c.label", "c.statement", "c.quote", "d.document_id"])
    .where("c.owner_id", "=", scope.ownerId).where("c.scope_id", "=", scope.scopeId).where("c.kind", "=", kind)
    .where("d.deleted_at", "is", null).where("d.source_updated_at", "<=", new Date(asOf))
    .whereRef("c.revision", "=", "d.revision").whereRef("c.incarnation", "=", "d.incarnation")
    .where(({ exists, selectFrom }) => exists(selectFrom("brain_document_refs as r").select("r.document_id")
      .whereRef("r.owner_id", "=", "d.owner_id").whereRef("r.scope_id", "=", "d.scope_id")
      .whereRef("r.document_id", "=", "d.document_id").where("r.kind", "=", "path").where("r.value", "in", [...paths])))
    .orderBy("d.source_updated_at", "desc").orderBy("d.document_id", "desc").orderBy("c.span_start", "asc")
    .orderBy("c.claim_id", "asc").orderBy("c.extractor", "asc")
    .limit(CLAIM_ROWS_PER_KIND).execute();
  const kept: typeof rows = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const text = `${normalizeBrainClaimText(row.label ?? "")}\u0000${normalizeBrainClaimText(row.statement)}`;
    if (seen.has(row.claim_id) || seen.has(text)) continue;
    seen.add(row.claim_id).add(text);
    kept.push(row);
    if (kept.length >= max) break;
  }
  if (kept.length === 0) return [];
  const ids = kept.map((row) => row.document_id);
  const [cites, touched] = await Promise.all([loadBrainCites(db, scope, ids), touchedPaths(db, scope, ids, paths)]);
  return kept.flatMap((row) => {
    const cite = cites.get(row.document_id);
    return cite === undefined ? [] : [{
      claimId: row.claim_id, kind, label: row.label, statement: row.statement, quote: row.quote,
      paths: touched.get(row.document_id)!, cite,
    }];
  });
}

/** Title suffix of part 2 or later of a spec file split into parts (git/specs.ts partTitle). */
const LATER_PART_TITLE = " \\(part ([2-9]|[0-9]{2,}) of [0-9]+\\)$";

/**
 * The live git_spec document of each spec folder: its spec.md first (a folder may also index plan.md, research.md,
 * data-model.md and quickstart.md), else the newest. All parts of a split file share one path ref and one date, so
 * part 1 goes before the later parts.
 */
export async function specCites(
  db: Db, scope: BrainScopeKey, specs: readonly string[],
): Promise<Map<string, BrainCiteView>> {
  if (specs.length === 0) return new Map();
  const rows = await db.selectFrom("brain_document_refs as r")
    .innerJoin("brain_documents as d", (join) => join.onRef("d.owner_id", "=", "r.owner_id")
      .onRef("d.scope_id", "=", "r.scope_id").onRef("d.document_id", "=", "r.document_id"))
    .distinctOn("r.value")
    .select(["r.value as spec", "d.document_id"])
    .where("r.owner_id", "=", scope.ownerId).where("r.scope_id", "=", scope.scopeId).where("r.kind", "=", "spec")
    .where("r.value", "in", [...specs]).where("d.provenance", "=", "git_spec").where("d.deleted_at", "is", null)
    .orderBy("r.value")
    .orderBy(({ exists, selectFrom }) => exists(selectFrom("brain_document_refs as p").select("p.document_id")
      .whereRef("p.owner_id", "=", "r.owner_id").whereRef("p.scope_id", "=", "r.scope_id")
      .whereRef("p.document_id", "=", "r.document_id").where("p.kind", "=", "path")
      .where("p.value", "=", sql<string>`${sql.ref("r.value")} || '/spec.md'`)), "desc")
    .orderBy(sql<boolean>`${sql.ref("d.title")} ~ ${LATER_PART_TITLE}`, "asc")
    .orderBy("d.source_updated_at", "desc").orderBy("d.document_id", "desc").execute();
  const cites = await loadBrainCites(db, scope, rows.map((row) => row.document_id));
  return new Map(rows.flatMap((row) => {
    const cite = cites.get(row.document_id);
    return cite === undefined ? [] : [[row.spec, cite] as const];
  }));
}
