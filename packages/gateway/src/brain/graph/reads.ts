/**
 * Graph entity reads: resolve an id or ref (a merged alias resolves to its entity), alias members, the entity list
 * (newest last seen first, keyset paged) and one entity with its aliases and a capped link count. No locks.
 */
import { sql, type RawBuilder, type Selectable } from "kysely";
import { BrainApiError } from "../api/types.js";
import {
  BRAIN_GRAPH_LIMITS, BrainFeatureError, type BrainEntitiesView, type BrainEntityKind, type BrainEntityRefView,
  type BrainEntityView,
} from "../contracts.js";
import { asIso } from "../mappers.js";
import { valueMatches } from "../refs-reads.js";
import type { BrainScopeKey } from "../types.js";
import { decodeGraphCursor, encodeGraphCursor, parseEntityInput, queryFingerprint } from "./ids.js";
import {
  BRAIN_GRAPH_LINK_COUNT_CAP, type BrainGraphEntitiesTable, type BrainGraphExecutor,
} from "./types.js";

export type BrainEntityRow = Selectable<BrainGraphEntitiesTable>;

export const ISO_MICROS = (column: string) => sql<string>`to_char(${sql.ref(column)} AT TIME ZONE 'UTC',
  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export function toEntityRef(
  row: Pick<BrainEntityRow, "entity_id" | "kind" | "key" | "display_name">,
): BrainEntityRefView {
  return { entityId: row.entity_id, kind: row.kind, key: row.key, displayName: row.display_name };
}

function entities(db: BrainGraphExecutor, scope: BrainScopeKey) {
  return db.selectFrom("brain_graph_entities as e").where("e.owner_id", "=", scope.ownerId)
    .where("e.scope_id", "=", scope.scopeId);
}

/** An entity id or ref, through a merged alias, to its entity row; invalid_request or entity_not_found. */
export async function resolveRoot(db: BrainGraphExecutor, scope: BrainScopeKey, raw: string): Promise<BrainEntityRow> {
  const parsed = parseEntityInput(raw);
  if (parsed === null) throw new BrainApiError("invalid_request");
  const alias = await db.selectFrom("brain_graph_aliases").select("entity_id").where("owner_id", "=", scope.ownerId)
    .where("scope_id", "=", scope.scopeId).where("alias_entity_id", "=", parsed.entityId).where("state", "=", "merged")
    .executeTakeFirst();
  const row = await entities(db, scope).selectAll("e").where("e.entity_id", "=", alias?.entity_id ?? parsed.entityId)
    .executeTakeFirst();
  if (row === undefined) throw new BrainFeatureError("entity_not_found");
  return row;
}

/** The entity and every alias merged into it (at most aliasesPerEntity + 1 ids). */
export async function membersOf(db: BrainGraphExecutor, scope: BrainScopeKey, entityId: string): Promise<string[]> {
  const rows = await db.selectFrom("brain_graph_aliases").select("alias_entity_id")
    .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId).where("entity_id", "=", entityId)
    .where("state", "=", "merged")
    .orderBy("alias_entity_id").limit(BRAIN_GRAPH_LIMITS.aliasesPerEntity).execute();
  return [entityId, ...rows.map((row) => row.alias_entity_id)];
}

/** Ref views of entity ids, each mapped to its merged root; ids without a row are left out. */
export async function entityRefViews(
  db: BrainGraphExecutor, scope: BrainScopeKey, ids: readonly string[],
): Promise<Map<string, BrainEntityRefView>> {
  const views = new Map<string, BrainEntityRefView>();
  if (ids.length === 0) return views;
  const roots = await db.selectFrom("brain_graph_aliases").select(["alias_entity_id", "entity_id"])
    .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId)
    .where("alias_entity_id", "in", [...ids]).where("state", "=", "merged").execute();
  const rootOf = new Map(roots.map((row) => [row.alias_entity_id, row.entity_id]));
  const wanted = [...new Set(ids.map((id) => rootOf.get(id) ?? id))];
  const rows = await entities(db, scope).select(["e.entity_id", "e.kind", "e.key", "e.display_name"])
    .where("e.entity_id", "in", wanted).execute();
  const byId = new Map(rows.map((row) => [row.entity_id, toEntityRef(row)]));
  for (const id of ids) {
    const view = byId.get(rootOf.get(id) ?? id);
    if (view !== undefined) views.set(id, view);
  }
  return views;
}

/** Entity `e` itself and every key merged into it: the ends its links may carry. */
const MEMBERS = sql`SELECT e.entity_id UNION ALL SELECT a.alias_entity_id FROM brain_graph_aliases a
  WHERE a.owner_id = e.owner_id AND a.scope_id = e.scope_id AND a.entity_id = e.entity_id AND a.state = 'merged'`;
/** Joined to links `l`: a tombstoned document's links stay stored until refresh removes them, but never count. */
export const LIVE_DOCUMENT = sql`JOIN brain_documents d ON d.owner_id = l.owner_id AND d.scope_id = l.scope_id
  AND d.document_id = l.document_id AND d.deleted_at IS NULL`;
const LIVE_LINK = (end: "from_entity_id" | "to_entity_id") => sql`EXISTS (SELECT 1 FROM brain_graph_links l
  ${LIVE_DOCUMENT}
  WHERE l.owner_id = e.owner_id AND l.scope_id = e.scope_id AND ${sql.ref(`l.${end}`)} IN (${MEMBERS}))`;
const PATH_REF = (match: RawBuilder<unknown>) => sql`EXISTS (SELECT 1 FROM brain_document_refs r
  WHERE r.owner_id = e.owner_id AND r.scope_id = e.scope_id AND r.kind = 'path' AND ${match})`;

/**
 * Entity `e` is still backed by live data: the project; a document entity whose document is live; a file or folder a
 * live document's path ref names; or any entity (or a key merged into it) at an end of a link from a live document.
 * A removed source's people and items stay stored until a refresh sweeps them, but never list.
 */
export const LIVE_ENTITY = sql<boolean>`(e.kind = 'project'
  OR (e.kind = 'document' AND EXISTS (SELECT 1 FROM brain_documents d WHERE d.owner_id = e.owner_id
    AND d.scope_id = e.scope_id AND d.document_id = e.document_id AND d.deleted_at IS NULL))
  OR (e.kind = 'file' AND ${PATH_REF(sql`r.value = e.key`)})
  OR (e.kind = 'folder' AND ${PATH_REF(sql`r.value >= e.key || '/' AND r.value < e.key || '0'`)})
  OR ${LIVE_LINK("from_entity_id")} OR ${LIVE_LINK("to_entity_id")})`;

export interface BrainEntitiesParsedQuery {
  readonly kind?: BrainEntityKind; readonly q?: string; readonly limit: number; readonly cursor?: string;
}

/** The cursor id of a page that ended among the exact matches: `exact:<key length>:<entity id>`. */
const EXACT_CURSOR_ID = /^exact:([0-9]{1,4}):(ent_[a-f0-9]{32})$/;

/**
 * Entities that are not merged aliases and are still backed by live data (LIVE_ENTITY). q is case-insensitive and
 * matches a key or name prefix, a spec's number ("124" finds specs/124-...) or a file or folder's last segment; exact
 * matches (the key, the name, a spec number or a file name with or without its extension) come first, shortest key
 * then newest, and the rest after them newest last_seen_at first. A cursor continues within the exact matches while a
 * page ends among them, so no entity is listed twice.
 */
export async function listGraphEntities(
  db: BrainGraphExecutor, scope: BrainScopeKey, query: BrainEntitiesParsedQuery,
): Promise<BrainEntitiesView> {
  const fingerprint = queryFingerprint(["entities", query.kind ?? null, query.q ?? null]);
  const cursor = query.cursor === undefined ? null : decodeGraphCursor(query.cursor, fingerprint);
  const exactAfter = cursor === null ? null : EXACT_CURSOR_ID.exec(cursor.id);
  if (exactAfter !== null && query.q === undefined) throw new BrainApiError("invalid_request");
  let page = entities(db, scope)
    .select(["e.entity_id", "e.kind", "e.key", "e.display_name", ISO_MICROS("e.last_seen_at").as("at")])
    .where(({ not, exists, selectFrom }) => not(exists(selectFrom("brain_graph_aliases as a").select("a.entity_id")
      .whereRef("a.owner_id", "=", "e.owner_id").whereRef("a.scope_id", "=", "e.scope_id")
      .whereRef("a.alias_entity_id", "=", "e.entity_id").where("a.state", "=", "merged"))))
    .where(LIVE_ENTITY);
  if (query.kind !== undefined) page = page.where("e.kind", "=", query.kind);
  let exact: (Awaited<ReturnType<typeof page.execute>>[number] & { key_length: number })[] = [];
  if (query.q !== undefined) {
    const q = query.q.toLowerCase();
    const leaf = sql`lower(substring(e.key from '[^/]*$'))`;
    const isPath = sql`e.kind IN ('file', 'folder')`;
    const exactMatch = sql<boolean>`(lower(e.key) = ${q} OR lower(e.display_name) = ${q}
      OR (e.kind = 'spec' AND starts_with(lower(e.key), ${`specs/${q}-`}))
      OR (${isPath} AND (${leaf} = ${q} OR regexp_replace(${leaf}, '[.][^.]*$', '') = ${q})))`;
    page = page.where(sql<boolean>`(starts_with(lower(e.key), ${q}) OR starts_with(lower(e.display_name), ${q})
      OR (e.kind = 'spec' AND starts_with(lower(e.key), ${`specs/${q}`}))
      OR (${isPath} AND starts_with(${leaf}, ${q})))`);
    if (cursor === null || exactAfter !== null) {
      let matches = page.where(exactMatch).select(sql<number>`length(e.key)`.as("key_length"));
      if (exactAfter !== null) {
        const length = Number(exactAfter[1]);
        matches = matches.where(sql<boolean>`(length(e.key) > ${length} OR (length(e.key) = ${length}
          AND (e.last_seen_at, e.entity_id) < (${cursor!.at}::timestamptz, ${exactAfter[2]})))`);
      }
      exact = await matches.orderBy(sql`length(e.key)`).orderBy("e.last_seen_at", "desc")
        .orderBy("e.entity_id", "desc").limit(query.limit + 1).execute();
    }
    page = page.where(sql<boolean>`NOT ${exactMatch}`);
  }
  if (cursor !== null && exactAfter === null) {
    page = page.where(sql<boolean>`(e.last_seen_at, e.entity_id) < (${cursor.at}::timestamptz, ${cursor.id})`);
  }
  // The rest starts at the top once the exact matches are all listed.
  const rest = exact.length > query.limit ? [] : await page.orderBy("e.last_seen_at", "desc")
    .orderBy("e.entity_id", "desc").limit(query.limit + 1 - exact.length).execute();
  const rows = [...exact, ...rest];
  const items = rows.slice(0, query.limit);
  const lastIndex = rows.length > query.limit ? items.length - 1 : -1;
  const lastExact = lastIndex >= 0 && lastIndex < exact.length ? exact[lastIndex] : undefined;
  const next = lastIndex < 0 ? null : lastExact !== undefined
    ? { at: lastExact.at, id: `exact:${Number(lastExact.key_length)}:${lastExact.entity_id}` }
    : { at: items[lastIndex]!.at, id: items[lastIndex]!.entity_id };
  return {
    items: items.map(toEntityRef),
    nextCursor: next === null ? null : encodeGraphCursor(fingerprint, next.at, next.id),
  };
}

/** Stored links of live documents touching any of the ids, counted up to BRAIN_GRAPH_LINK_COUNT_CAP + 1. */
async function countLinks(db: BrainGraphExecutor, scope: BrainScopeKey, ids: readonly string[]): Promise<number> {
  const result = await sql<{ n: number }>`SELECT count(*)::int AS n FROM (SELECT 1 FROM brain_graph_links l
    ${LIVE_DOCUMENT} WHERE l.owner_id = ${scope.ownerId} AND l.scope_id = ${scope.scopeId}
      AND (l.from_entity_id IN (${sql.join(ids)}) OR l.to_entity_id IN (${sql.join(ids)}))
    LIMIT ${BRAIN_GRAPH_LINK_COUNT_CAP + 1}) AS capped`.execute(db);
  return Number(result.rows[0]!.n);
}

/** Live documents with a path ref to the file (or under the folder): its `changed` links, which are never stored. */
async function countChanged(db: BrainGraphExecutor, scope: BrainScopeKey, kind: string, key: string): Promise<number> {
  if (kind !== "file" && kind !== "folder") return 0;
  const match = kind === "file" ? sql<boolean>`r.value = ${key}`
    : valueMatches("r.value", { value: key, mode: "under" });
  const result = await sql<{ n: number }>`SELECT count(*)::int AS n FROM (SELECT DISTINCT r.document_id
    FROM brain_document_refs r WHERE r.owner_id = ${scope.ownerId} AND r.scope_id = ${scope.scopeId}
      AND r.kind = 'path' AND ${match} LIMIT ${BRAIN_GRAPH_LINK_COUNT_CAP + 1}) AS capped`.execute(db);
  return Number(result.rows[0]!.n);
}

/** First and last seen over the entity and every alias merged into it. */
async function seenRange(db: BrainGraphExecutor, scope: BrainScopeKey, ids: readonly string[]) {
  return db.selectFrom("brain_graph_entities").where("owner_id", "=", scope.ownerId)
    .where("scope_id", "=", scope.scopeId).where("entity_id", "in", [...ids])
    .select((eb) => [eb.fn.min("first_seen_at").as("first"), eb.fn.max("last_seen_at").as("last")])
    .executeTakeFirstOrThrow();
}

export async function getGraphEntity(
  db: BrainGraphExecutor, scope: BrainScopeKey, raw: string,
): Promise<BrainEntityView> {
  const row = await resolveRoot(db, scope, raw);
  const members = await membersOf(db, scope, row.entity_id);
  const [aliasRows, stored, changed, seen] = await Promise.all([
    db.selectFrom("brain_graph_aliases").select(["alias_key", "reason", "state", "created_at"])
      .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId)
      .where("entity_id", "=", row.entity_id).orderBy("state") // 'merged' < 'split': no split row hides a merge
      .orderBy("created_at").orderBy("alias_key").limit(BRAIN_GRAPH_LIMITS.aliasesPerEntity).execute(),
    countLinks(db, scope, members), countChanged(db, scope, row.kind, row.key), seenRange(db, scope, members),
  ]);
  const linkCount = stored + changed;
  return {
    ...toEntityRef(row),
    aliases: aliasRows.map((alias) => ({
      aliasKey: alias.alias_key, reason: alias.reason, state: alias.state, createdAt: asIso(alias.created_at),
    })),
    firstSeenAt: asIso(seen.first ?? row.first_seen_at), lastSeenAt: asIso(seen.last ?? row.last_seen_at),
    linkCount: Math.min(linkCount, BRAIN_GRAPH_LINK_COUNT_CAP), linkCountCapped: linkCount > BRAIN_GRAPH_LINK_COUNT_CAP,
  };
}
