/**
 * Neighbourhoods: the center's direct links (stored links of the entity and its merged aliases, plus `changed` from
 * path refs when the center is a file or a document), newest first and keyset paged, a page stopping before the link
 * that would pass the node cap; with hops = 2, the stored links (both directions) and `changed` links of the
 * neighbours as their merged entities (every key merged into them) too, within the node and link caps (descriptions,
 * authors, specs and parent PRs before file changes). Endpoints show as their merged entity.
 */
import { sql } from "kysely";
import {
  BRAIN_GRAPH_LIMITS, BRAIN_LINK_TYPES, type BrainCiteView, type BrainEntityRefView,
  type BrainLinkMode, type BrainLinkType, type BrainLinkView, type BrainNeighbourhoodView,
} from "../contracts.js";
import { loadBrainCites } from "../cite.js";
import { asIso } from "../mappers.js";
import type { BrainScopeKey } from "../types.js";
import {
  brainEntityId, brainLinkId, decodeGraphCursor, encodeGraphCursor, entityDraft, queryFingerprint,
} from "./ids.js";
import { entityRefViews, LIVE_DOCUMENT, membersOf, resolveRoot, toEntityRef } from "./reads.js";
import type { BrainGraphExecutor } from "./types.js";

export interface BrainLinksParsedQuery {
  readonly hops: 1 | 2; readonly types?: readonly BrainLinkType[]; readonly direction: "out" | "in" | "both";
  readonly limit: number; readonly cursor?: string;
}

interface LinkRow {
  readonly sort_key: string; readonly type: BrainLinkType; readonly mode: BrainLinkMode;
  readonly from_entity_id: string | null; readonly to_entity_id: string | null; readonly document_id: string;
  readonly ref_kind: string | null; readonly quote: string | null; readonly at: string; readonly path: string | null;
}

const COLUMNS = sql`u.sort_key, u.type, u.mode, u.from_entity_id, u.to_entity_id, u.document_id, u.ref_kind, u.quote,
  to_char(u.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at, u.path`;

/** A raw SQL fragment. */
type Fragment = ReturnType<typeof sql.raw>;

/** Stored links of live documents only, so links a refresh has yet to remove never fill a page or a cap. */
function storedLinks(scope: BrainScopeKey, types: readonly string[], endpoints: Fragment) {
  return sql`SELECT l.link_id AS sort_key, l.type, l.mode, l.from_entity_id, l.to_entity_id, l.document_id, l.ref_kind,
    l.quote, l.at, NULL AS path FROM brain_graph_links l ${LIVE_DOCUMENT} WHERE l.owner_id = ${scope.ownerId}
    AND l.scope_id = ${scope.scopeId} AND l.type IN (${sql.join(types)}) AND ${endpoints}`;
}

/** `changed` (document -> file) from the path refs of live documents; the sort key is unique per document and path. */
function changedLinks(scope: BrainScopeKey, where: Fragment) {
  return sql`SELECT 'changed:' || r.document_id || ':' || md5(r.value) AS sort_key, 'changed' AS type,
    'explicit' AS mode, NULL AS from_entity_id, NULL AS to_entity_id, r.document_id, 'path' AS ref_kind, NULL AS quote,
    d.source_updated_at AS at, r.value AS path FROM brain_document_refs r JOIN brain_documents d
    ON d.owner_id = r.owner_id AND d.scope_id = r.scope_id AND d.document_id = r.document_id
    WHERE r.owner_id = ${scope.ownerId} AND r.scope_id = ${scope.scopeId} AND r.kind = 'path'
    AND d.deleted_at IS NULL AND ${where}`;
}

/** Second-hop order: these link types fill the node cap before the rest, and `changed` comes last. */
const HOP2_FIRST = ["describes", "authored", "implements_spec", "part_of"] as const;
const HOP2_RANK = sql`CASE u.type ${sql.join(HOP2_FIRST.map((type, rank) => sql`WHEN ${type} THEN ${sql.lit(rank)}`),
  sql` `)} WHEN 'changed' THEN 9 ELSE 5 END`;

const inList = (column: string, ids: readonly string[]) => sql`${sql.ref(column)} IN (${sql.join(ids)})`;
const documentEntity = (documentId: string) => brainEntityId("document", documentId);
/** Raw endpoint ids; a `changed` row is its document to the file of its path. */
const endpoints = (row: LinkRow): string[] => row.path === null ? [row.from_entity_id!, row.to_entity_id!]
  : [documentEntity(row.document_id), brainEntityId("file", row.path)];

/** The longest prefix of a page whose endpoints fit the node cap with the center (raw ids, so never too many). */
function fitNodeCap(page: readonly LinkRow[], members: ReadonlySet<string>): readonly LinkRow[] {
  const seen = new Set<string>();
  for (const [index, row] of page.entries()) {
    for (const id of endpoints(row)) if (!members.has(id)) seen.add(id);
    if (seen.size >= BRAIN_GRAPH_LIMITS.neighbourhoodNodesMax) return page.slice(0, index);
  }
  return page;
}

/**
 * The entities the neighbours show as (a merged alias as its entity; never the center) and every key merged into
 * them: the ends the second hop reads.
 */
async function neighbourMembers(
  db: BrainGraphExecutor, scope: BrainScopeKey, neighbours: readonly string[], center: ReadonlySet<string>,
): Promise<string[]> {
  if (neighbours.length === 0) return [];
  const aliases = () => db.selectFrom("brain_graph_aliases").where("owner_id", "=", scope.ownerId)
    .where("scope_id", "=", scope.scopeId).where("state", "=", "merged");
  const merged = await aliases().select(["alias_entity_id", "entity_id"]).where("alias_entity_id", "in", neighbours)
    .execute();
  const rootOf = new Map(merged.map((row) => [row.alias_entity_id, row.entity_id]));
  const roots = [...new Set(neighbours.map((id) => rootOf.get(id) ?? id))].filter((id) => !center.has(id));
  if (roots.length === 0) return [];
  const members = await aliases().select("alias_entity_id").where("entity_id", "in", roots)
    .limit(roots.length * BRAIN_GRAPH_LIMITS.aliasesPerEntity).execute();
  return [...roots, ...members.map((row) => row.alias_entity_id)];
}

export async function graphNeighbourhood(
  db: BrainGraphExecutor, scope: BrainScopeKey, entity: string, query: BrainLinksParsedQuery,
): Promise<BrainNeighbourhoodView> {
  const root = await resolveRoot(db, scope, entity);
  const members = await membersOf(db, scope, root.entity_id);
  const types = query.types ?? BRAIN_LINK_TYPES;
  const stored = types.filter((type) => type !== "changed");
  const fingerprint = queryFingerprint(["links", root.entity_id, [...types].sort(), query.direction, query.hops]);
  const cursor = query.cursor === undefined ? null : decodeGraphCursor(query.cursor, fingerprint);
  const parts: Fragment[] = [];
  if (stored.length > 0) {
    const out = inList("l.from_entity_id", members);
    const into = inList("l.to_entity_id", members);
    parts.push(storedLinks(scope, stored, query.direction === "out" ? out : query.direction === "in" ? into
      : sql`(${out} OR ${into})`));
  }
  const changedOf = root.kind === "file" && query.direction !== "out" ? sql`r.value = ${root.key}`
    : root.kind === "document" && query.direction !== "in" ? sql`r.document_id = ${root.key}` : null;
  if (types.includes("changed") && changedOf !== null) parts.push(changedLinks(scope, changedOf));
  const keyset = cursor === null ? sql`` : sql`WHERE (u.at, u.sort_key) < (${cursor.at}::timestamptz, ${cursor.id})`;
  const union = sql.join(parts, sql` UNION ALL `);
  const hop1 = parts.length === 0 ? [] : (await sql<LinkRow>`SELECT ${COLUMNS} FROM (${union}) AS u ${keyset}
    ORDER BY u.at DESC, u.sort_key DESC LIMIT ${query.limit + 1}`.execute(db)).rows;
  const memberSet = new Set(members);
  const full = hop1.slice(0, query.limit);
  const page = fitNodeCap(full, memberSet);
  const last = page.length < full.length || hop1.length > query.limit ? page[page.length - 1] : undefined;

  let hop2: LinkRow[] = [];
  let truncated = page.length < full.length;
  const neighbours = [...new Set(page.flatMap(endpoints))].filter((id) => !memberSet.has(id));
  const ids = query.hops === 2 ? await neighbourMembers(db, scope, neighbours, memberSet) : [];
  if (ids.length > 0) {
    const room = BRAIN_GRAPH_LIMITS.neighbourhoodLinksMax - page.length;
    const touching = sql`(${inList("l.from_entity_id", ids)} OR ${inList("l.to_entity_id", ids)})
      AND NOT (${inList("l.from_entity_id", members)}) AND NOT (${inList("l.to_entity_id", members)})`;
    const keys = (kind: string) => sql`(SELECT e.key COLLATE "C" FROM brain_graph_entities e
      WHERE e.owner_id = ${scope.ownerId} AND e.scope_id = ${scope.scopeId} AND e.kind = ${kind}
      AND ${inList("e.entity_id", ids)})`;
    // Changed links of neighbour documents and into neighbour files, except the center's own (those are direct).
    const changed = changedLinks(scope, sql`(r.document_id IN ${keys("document")} OR r.value IN ${keys("file")})
      AND r.document_id <> ${root.kind === "document" ? root.key : ""}
      AND r.value <> ${root.kind === "file" ? root.key : ""}`);
    const hop2Parts = [...(stored.length > 0 ? [storedLinks(scope, stored, touching)] : []),
      ...(types.includes("changed") ? [changed] : [])];
    // Who and what first (descriptions, authors, specs, parent PRs), file changes last, newest first within each.
    hop2 = (await sql<LinkRow>`SELECT ${COLUMNS} FROM (${sql.join(hop2Parts, sql` UNION ALL `)}) AS u
      ORDER BY ${HOP2_RANK}, u.at DESC, u.sort_key DESC LIMIT ${room + 1}`.execute(db)).rows;
    truncated ||= hop2.length > room;
    hop2 = hop2.slice(0, room);
  }

  const rows = [...page, ...hop2];
  const [cites, views] = await Promise.all([
    loadBrainCites(db, scope, rows.map((row) => row.document_id)),
    entityRefViews(db, scope, [...new Set(rows.flatMap(endpoints))]),
  ]);
  const viewOf = (id: string, row: LinkRow, cite: BrainCiteView): BrainEntityRefView | undefined => id
    === documentEntity(row.document_id)
    ? { entityId: id, ...entityDraft("document", row.document_id, cite.title) } : views.get(id);
  const center = toEntityRef(root);
  const nodes = new Map<string, BrainEntityRefView>([[center.entityId, center]]);
  const links: BrainLinkView[] = [];
  for (const row of rows) {
    const cite = cites.get(row.document_id);
    if (cite === undefined) continue;
    const [fromId, toId] = endpoints(row);
    const from = viewOf(fromId!, row, cite);
    const to = viewOf(toId!, row, cite);
    if (from === undefined || to === undefined) continue;
    const added = [from, to].filter((view) => !nodes.has(view.entityId));
    if (nodes.size + added.length > BRAIN_GRAPH_LIMITS.neighbourhoodNodesMax) {
      truncated = true;
      continue;
    }
    for (const view of added) nodes.set(view.entityId, view);
    links.push({
      linkId: row.type === "changed" ? brainLinkId(row.document_id, "changed", fromId!, toId!) : row.sort_key,
      type: row.type, mode: row.mode, from, to, evidence: { cite, refKind: row.ref_kind, quote: row.quote },
      at: asIso(row.at),
    });
  }
  return {
    center, hops: query.hops, nodes: [...nodes.values()], links, truncated,
    nextCursor: last === undefined ? null : encodeGraphCursor(fingerprint, last.at, last.sort_key),
  };
}
