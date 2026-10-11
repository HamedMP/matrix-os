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
  BRAIN_GRAPH_IDENTITIES_PER_DOCUMENT, type BrainEntityDraft, type BrainGraphDatabase, type BrainGraphExecutor,
  type BrainIdentityPair,
} from "./types.js";

/** capacity: the entities the derivation would add do not fit the scope's limit; nothing was written. */
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

/**
 * Whether state row `s` read a decision path as known (a path ref of the scope) that is no longer, or the reverse:
 * its decided_in file links then disagree with the scope's path refs.
 */
export function decisionPathsChangedSql(s: string) {
  const ref = (column: string) => sql.ref(`${s}.${column}`);
  return sql<boolean>`EXISTS (SELECT 1 FROM jsonb_each(${ref("decision_paths")}) AS p(path, known)
    WHERE p.known <> to_jsonb(EXISTS (SELECT 1 FROM brain_document_refs r WHERE r.owner_id = ${ref("owner_id")}
      AND r.scope_id = ${ref("scope_id")} AND r.kind = 'path' AND r.value = p.path)))`;
}

/** md5 of the refs of document `d` (a sync replaces refs without a new revision when the content is unchanged). */
export function refsDigestSql(d: string) {
  const ref = (column: string) => sql.ref(`${d}.${column}`);
  return sql<string>`(SELECT md5(coalesce(jsonb_agg(jsonb_build_array(r.kind, r.value) ORDER BY r.kind, r.value)::text,
    '')) FROM brain_document_refs r WHERE r.owner_id = ${ref("owner_id")} AND r.scope_id = ${ref("scope_id")}
    AND r.document_id = ${ref("document_id")})`;
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

/**
 * Marks outdated (state row kept) the documents that read this one, only when what they read changed: children naming
 * it in a `parent` ref (never itself) when what it describes changed and, for a github_pr, git_commit documents (ids
 * from the scope's git source identity) whose `part_of` link to its pull request disagrees with its `commit` refs.
 * Each set is one write, never a capped list, so no dependent keeps a stale link once its own row reads as current.
 */
async function nudgeDependents(
  trx: Transaction<BrainGraphDatabase>, scope: BrainScopeKey, documentId: string, provenance: string,
  before: readonly string[], after: readonly string[], shas: readonly string[],
): Promise<void> {
  const outdated = () => trx.updateTable("brain_graph_state").set({ claims_digest: OUTDATED_DIGEST })
    .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId);
  const commitLinks = (targets: readonly string[]) => trx.selectFrom("brain_graph_links").select("document_id")
    .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId).where("type", "=", "part_of")
    .where("ref_kind", "=", "commit").where("to_entity_id", "in", targets);
  if (before.length !== after.length || before.some((entityId) => !after.includes(entityId))) {
    await outdated().where("document_id", "<>", documentId).where("document_id", "in", trx
      .selectFrom("brain_document_refs").select("document_id").where("owner_id", "=", scope.ownerId)
      .where("scope_id", "=", scope.scopeId).where("kind", "=", "parent").where("value", "=", documentId)).execute();
  }
  const watched = [...new Set([...before, ...after])];
  if (provenance !== "github_pr" || watched.length === 0) return;
  const sources = await trx.selectFrom("brain_sources").select("external_ref")
    .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId).where("kind", "=", "git")
    .where("deleted_at", "is", null).limit(1).execute();
  // At most one id per `commit` ref of the pull request (BRAIN_DOCUMENT_REFS_MAX).
  const wanted = [...new Set(sources.flatMap(({ external_ref: identity }) =>
    shas.map((sha) => commitDocumentId(identity, sha))))];
  // Commits linked to the pull request that its commit refs no longer name, then named commits not linked to it.
  let stale = outdated().where("document_id", "in", commitLinks(watched));
  if (wanted.length > 0) stale = stale.where("document_id", "not in", wanted);
  await stale.execute();
  if (wanted.length === 0) return;
  let unlinked = outdated().where("document_id", "in", wanted);
  if (after.length > 0) unlinked = unlinked.where("document_id", "not in", commitLinks(after));
  await unlinked.execute();
}

/** Entities of the scope, counted up to `max`. */
export async function countGraphEntities(trx: BrainGraphExecutor, scope: BrainScopeKey, max: number): Promise<number> {
  const result = await sql<{ n: number }>`SELECT count(*)::int AS n FROM (SELECT 1 FROM brain_graph_entities
    WHERE owner_id = ${scope.ownerId} AND scope_id = ${scope.scopeId} LIMIT ${max}) AS capped`.execute(trx);
  return Number(result.rows[0]!.n);
}

/**
 * Whether the entities without a row yet (the document's own included) fit under `max`. Read under the graph lock,
 * so entities another writer added are counted; a derivation that adds none always fits.
 */
async function entitiesFit(
  trx: BrainGraphExecutor, scope: BrainScopeKey, entities: readonly BrainEntityDraft[], max: number,
): Promise<boolean> {
  const ids = entities.map((entity) => brainEntityId(entity.kind, entity.key));
  const existing = await trx.selectFrom("brain_graph_entities").select("entity_id")
    .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId).where("entity_id", "in", ids)
    .execute();
  const added = ids.length - existing.length;
  return added === 0 || await countGraphEntities(trx, scope, max) + added <= max;
}

/** Inserts new entities and widens first/last seen of existing ones. */
async function writeEntities(
  trx: Transaction<BrainGraphDatabase>, scope: BrainScopeKey, entities: readonly BrainEntityDraft[],
  documentId: string, at: string,
): Promise<void> {
  const rows = entities.map((entity) => ({
    owner_id: scope.ownerId, scope_id: scope.scopeId, entity_id: brainEntityId(entity.kind, entity.key),
    kind: entity.kind, key: entity.key, display_name: entity.displayName,
    document_id: entity.kind === "document" ? documentId : null, first_seen_at: at, last_seen_at: at,
  }));
  const document = rows.find((row) => row.kind === "document")!;
  // Its title follows the document; its seen range only widens, as for every other entity.
  await trx.insertInto("brain_graph_entities").values(document)
    .onConflict((conflict) => conflict.columns(["owner_id", "scope_id", "entity_id"]).doUpdateSet({
      display_name: document.display_name,
      first_seen_at: sql`LEAST(brain_graph_entities.first_seen_at, excluded.first_seen_at)`,
      last_seen_at: sql`GREATEST(brain_graph_entities.last_seen_at, excluded.last_seen_at)`,
    })).execute();
  const others = rows.filter((row) => row !== document);
  if (others.length === 0) return;
  await trx.insertInto("brain_graph_entities").values(others).onConflict((conflict) => conflict.doNothing()).execute();
  await trx.updateTable("brain_graph_entities")
    .set({
      first_seen_at: sql`LEAST(first_seen_at, ${at}::timestamptz)`,
      last_seen_at: sql`GREATEST(last_seen_at, ${at}::timestamptz)`,
    })
    .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId)
    .where("entity_id", "in", others.map((row) => row.entity_id))
    .where((eb) => eb.or([eb("first_seen_at", ">", at), eb("last_seen_at", "<", at)])).execute();
  // A person first seen as a bare identity (a ref) takes the first real name seen with it (a trailer or footer).
  const named = others.filter((other) => other.kind === "person" && other.display_name !== personDisplay(other.key));
  for (const row of named) {
    await trx.updateTable("brain_graph_entities").set({ display_name: row.display_name })
      .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId)
      .where("entity_id", "=", row.entity_id).where("display_name", "=", personDisplay(row.key)).execute();
  }
}

/**
 * Re-derives one document, or removes its graph rows when it is tombstoned or gone; `capacity` (nothing written) when
 * the entities it would add pass `maxEntities`.
 */
export async function deriveGraphDocument(
  trx: Transaction<BrainGraphDatabase>, scope: BrainScopeKey, documentId: string, now: Date, maxEntities: number,
): Promise<BrainGraphDeriveOutcome> {
  const document = await trx.selectFrom("brain_documents as d")
    .select(["d.document_id", "d.incarnation", "d.revision", "d.provenance", "d.title", "d.body", "d.deleted_at",
      claimsDigestSql("d").as("claims_digest"), refsDigestSql("d").as("refs_digest"),
      sql<string>`to_char(d.source_updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as("at")])
    .where("d.owner_id", "=", scope.ownerId).where("d.scope_id", "=", scope.scopeId)
    .where("d.document_id", "=", documentId).executeTakeFirst();
  if (document === undefined || document.deleted_at !== null) {
    await removeDocument(trx, scope, documentId, document?.provenance ?? "", now);
    return "removed";
  }
  const refs = await trx.selectFrom("brain_document_refs").select(["kind", "value"])
    .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId).where("document_id", "=", documentId)
    .orderBy("kind").orderBy("value").limit(200).execute();
  const claims = await trx.selectFrom("brain_claims").select("quote")
    .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId).where("document_id", "=", documentId)
    .where("kind", "=", "decision").where("incarnation", "=", document.incarnation)
    .where("revision", "=", document.revision).orderBy("span_start").orderBy("claim_id").orderBy("extractor")
    .limit(100).execute();
  const decisionQuotes = claims.map((claim) => claim.quote);
  const candidates = quotedPaths(decisionQuotes).slice(0, 100);
  const known = candidates.length === 0 ? [] : await trx.selectFrom("brain_document_refs").select("value").distinct()
    .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId).where("kind", "=", "path")
    .where("value", "in", candidates).execute();
  const knownPaths = new Set(known.map((row) => row.value));
  const derivation = deriveBrainGraph({
    documentId, provenance: document.provenance, title: document.title, body: document.body, refs,
    decisionQuotes, knownPaths,
    parentTargets: await parentTargets(trx, scope, refs),
    commitPullRequests: document.provenance === "git_commit" ? await commitPullRequests(trx, scope, document.body) : [],
  });
  if (!await entitiesFit(trx, scope, derivation.entities, maxEntities)) return "capacity";
  const previousNames = await readIdentities(trx, scope, documentId);
  const before = await describedIds(trx, scope, documentId);
  await trx.deleteFrom("brain_graph_links").where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId)
    .where("document_id", "=", documentId).execute();
  await writeEntities(trx, scope, derivation.entities, documentId, document.at);
  if (derivation.links.length > 0) {
    await trx.insertInto("brain_graph_links").values(derivation.links.map((link) => {
      const fromId = brainEntityId(link.from.kind, link.from.key);
      const toId = brainEntityId(link.to.kind, link.to.key);
      return {
        owner_id: scope.ownerId, scope_id: scope.scopeId, link_id: brainLinkId(documentId, link.type, fromId, toId),
        document_id: documentId, type: link.type, mode: link.mode, from_entity_id: fromId, to_entity_id: toId,
        ref_kind: link.refKind, quote: link.quote, at: document.at,
      };
    })).execute();
  }
  const identities = derivation.identities.slice(0, BRAIN_GRAPH_IDENTITIES_PER_DOCUMENT);
  const decisionPaths = Object.fromEntries(candidates.map((path) => [path, knownPaths.has(path)]));
  const state = {
    incarnation: document.incarnation, revision: document.revision, claims_digest: document.claims_digest,
    refs_digest: document.refs_digest, identities: sql`${JSON.stringify(identities)}::jsonb`,
    decision_paths: sql`${JSON.stringify(decisionPaths)}::jsonb`, source_updated_at: document.at,
    link_count: derivation.links.length, derived_at: now.toISOString(),
  };
  await trx.insertInto("brain_graph_state")
    .values({ owner_id: scope.ownerId, scope_id: scope.scopeId, document_id: documentId, ...state })
    .onConflict((conflict) => conflict.columns(["owner_id", "scope_id", "document_id"]).doUpdateSet(state)).execute();
  const names = new Set([...previousNames, ...identities.map((pair) => pair.n)]);
  await reconcileNameAliases(trx, scope, [...names], now);
  const after = derivation.links.filter((link) => link.type === "describes")
    .map((link) => brainEntityId(link.to.kind, link.to.key));
  const shas = refs.filter((ref) => ref.kind === "commit").map((ref) => ref.value);
  await nudgeDependents(trx, scope, documentId, document.provenance, before, after, shas);
  return "derived";
}
