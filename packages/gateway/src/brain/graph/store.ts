/**
 * Graph writes. One transaction per document under the brain-graph:<scope> lock (never the core brain:<scope> lock):
 * re-read the live document, its refs and current decision claims, derive, replace the document's links, add its
 * entities, record what it was derived from, reconcile name aliases and nudge dependent documents. Core tables are
 * only read.
 */
import { sql, type Kysely, type Transaction } from "kysely";
import { BRAIN_FEATURE_SCOPE_LOCK_PREFIXES, BRAIN_GRAPH_LIMITS } from "../contracts.js";
import { commitDocumentId } from "../git/documents.js";
import type { BrainScopeKey } from "../types.js";
import { parseBrainGitFooter } from "../why.js";
import { reconcileNameAliases } from "./aliases.js";
import { deriveBrainGraph, describedFor, quotedPaths } from "./derive.js";
import { brainEntityId, brainLinkId, personDisplay } from "./ids.js";
import {
  BRAIN_GRAPH_IDENTITIES_PER_DOCUMENT, BRAIN_GRAPH_NUDGE_MAX, type BrainEntityDraft, type BrainGraphDatabase,
  type BrainGraphExecutor, type BrainIdentityPair,
} from "./types.js";

/** Entities a batch may still add before the scope is full; derivation stops (capacity) at zero. */
export interface BrainGraphCapacity { remaining: number }
export type BrainGraphDeriveOutcome = "derived" | "removed" | "capacity";

const FOOTER_TAIL_CHARS = 2_048;
const DOCUMENT_ID = /^[a-f0-9]{64}$/;
/** A claims digest no md5 of decision claims equals: the row reads as pending until derived or removed again. */
const OUTDATED_DIGEST = "0".repeat(32);

export function withGraphLock<T>(
  db: Kysely<BrainGraphDatabase>, scope: BrainScopeKey, fn: (trx: Transaction<BrainGraphDatabase>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await sql`SET LOCAL statement_timeout = '15s'`.execute(trx);
    const key = `${BRAIN_FEATURE_SCOPE_LOCK_PREFIXES.graph}${scope.scopeId}`;
    await sql`SELECT pg_advisory_xact_lock(hashtext(${scope.ownerId}), hashtext(${key}))`.execute(trx);
    return fn(trx);
  });
}

/** md5 of the current decision claims of document `d`; the same expression in derivation and the pending scan. */
export function claimsDigestSql(d: string) {
  const ref = (column: string) => sql.ref(`${d}.${column}`);
  return sql<string>`(SELECT md5(coalesce(string_agg(c.claim_id || ':' || c.extractor, ',' ORDER BY c.claim_id,
    c.extractor), '')) FROM brain_claims c WHERE c.owner_id = ${ref("owner_id")} AND c.scope_id = ${ref("scope_id")}
    AND c.document_id = ${ref("document_id")} AND c.kind = 'decision' AND c.incarnation = ${ref("incarnation")}
    AND c.revision = ${ref("revision")})`;
}

async function readIdentities(trx: BrainGraphExecutor, scope: BrainScopeKey, documentId: string): Promise<string[]> {
  const row = await trx.selectFrom("brain_graph_state").select("identities")
    .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId).where("document_id", "=", documentId)
    .executeTakeFirst();
  const pairs = Array.isArray(row?.identities) ? row.identities as BrainIdentityPair[] : [];
  return pairs.map((pair) => pair.n);
}

/** Entity ids of the document's stored `describes` links: what its last derivation found it is the record of. */
async function describedIds(trx: BrainGraphExecutor, scope: BrainScopeKey, documentId: string): Promise<string[]> {
  const rows = await trx.selectFrom("brain_graph_links").select("to_entity_id").where("owner_id", "=", scope.ownerId)
    .where("scope_id", "=", scope.scopeId).where("document_id", "=", documentId).where("type", "=", "describes")
    .limit(BRAIN_GRAPH_LIMITS.linksPerDocument).execute();
  return rows.map((row) => row.to_entity_id);
}

/** Drops the document's links, state and document entity; reconciles its names and nudges its dependents. */
async function removeDocument(
  trx: Transaction<BrainGraphDatabase>, scope: BrainScopeKey, documentId: string, provenance: string, now: Date,
): Promise<void> {
  const names = await readIdentities(trx, scope, documentId);
  const before = await describedIds(trx, scope, documentId);
  for (const table of ["brain_graph_links", "brain_graph_state", "brain_graph_entities"] as const) {
    await trx.deleteFrom(table).where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId)
      .where("document_id", "=", documentId).execute();
  }
  await reconcileNameAliases(trx, scope, names, now);
  await nudgeDependents(trx, scope, documentId, provenance, before, [], []);
}

/** The pull requests and issues the parent document (its `parent` ref) is the record of. */
async function parentTargets(
  trx: BrainGraphExecutor, scope: BrainScopeKey, refs: readonly { kind: string; value: string }[],
): Promise<BrainEntityDraft[]> {
  const parentId = refs.find((ref) => ref.kind === "parent" && DOCUMENT_ID.test(ref.value))?.value;
  if (parentId === undefined) return [];
  const tail = sql<string>`right(body, ${FOOTER_TAIL_CHARS}::int)`.as("tail");
  const parent = await trx.selectFrom("brain_documents").select(["provenance", tail])
    .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId).where("document_id", "=", parentId)
    .where("deleted_at", "is", null).executeTakeFirst();
  if (parent === undefined) return [];
  const parentRefs = await trx.selectFrom("brain_document_refs").select(["kind", "value"])
    .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId).where("document_id", "=", parentId)
    .where("kind", "in", ["pr", "handle"]).limit(200).execute();
  return describedFor(parent.provenance, parent.tail, parentRefs).map((described) => described.entity)
    .filter((entity) => entity.kind === "pull_request" || entity.kind === "issue");
}

/** PR numbers of live github_pr documents whose `commit` refs hold this git_commit's footer sha. */
async function commitPullRequests(trx: BrainGraphExecutor, scope: BrainScopeKey, body: string): Promise<string[]> {
  const sha = parseBrainGitFooter(body)?.sha;
  if (sha === undefined) return [];
  const rows = await trx.selectFrom("brain_document_refs as c")
    .innerJoin("brain_documents as d", (join) => join.onRef("d.owner_id", "=", "c.owner_id")
      .onRef("d.scope_id", "=", "c.scope_id").onRef("d.document_id", "=", "c.document_id"))
    .innerJoin("brain_document_refs as p", (join) => join.onRef("p.owner_id", "=", "c.owner_id")
      .onRef("p.scope_id", "=", "c.scope_id").onRef("p.document_id", "=", "c.document_id"))
    .select("p.value").distinct()
    .where("c.owner_id", "=", scope.ownerId).where("c.scope_id", "=", scope.scopeId).where("c.kind", "=", "commit")
    .where("c.value", "=", sha).where("d.deleted_at", "is", null).where("d.provenance", "=", "github_pr")
    .where("p.kind", "=", "pr").orderBy("p.value").limit(8).execute();
  return rows.map((row) => row.value);
}
