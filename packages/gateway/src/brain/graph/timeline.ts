/**
 * Timelines: live documents touching one entity, newest source_updated_at first, then document id, keyset paged.
 * File and folder timelines read path refs (the bytewise range brain_why uses) for `changed`; every kind also reads
 * the stored links of the entity and of the aliases merged into it. Reads never derive.
 */
import { sql, type SqlBool } from "kysely";
import {
  BRAIN_GRAPH_LIMITS, BRAIN_LINK_TYPES, type BrainIndexFreshness, type BrainLinkType, type BrainTimelineView,
} from "../contracts.js";
import { loadBrainCites } from "../cite.js";
import { valueMatches } from "../refs-reads.js";
import type { BrainScopeKey } from "../types.js";
import { decodeGraphCursor, encodeGraphCursor, queryFingerprint } from "./ids.js";
import { ISO_MICROS, membersOf, resolveRoot, toEntityRef } from "./reads.js";
import type { BrainGraphExecutor } from "./types.js";

export interface BrainTimelineParsedQuery {
  readonly entity: string; readonly linkTypes?: readonly BrainLinkType[]; readonly from: string | null;
  readonly to: string | null; readonly limit: number; readonly cursor?: string;
}

export async function graphTimeline(
  db: BrainGraphExecutor, scope: BrainScopeKey, query: BrainTimelineParsedQuery, freshness: BrainIndexFreshness,
): Promise<BrainTimelineView> {
  const root = await resolveRoot(db, scope, query.entity);
  const members = await membersOf(db, scope, root.entity_id);
  const types = query.linkTypes ?? BRAIN_LINK_TYPES;
  const pathMatch = root.kind === "file" || root.kind === "folder"
    ? { value: root.key, mode: root.kind === "file" ? "exact" as const : "under" as const } : null;
  const changed = pathMatch !== null && types.includes("changed");
  const stored = types.filter((type) => type !== "changed");
  const fingerprint = queryFingerprint(["timeline", root.entity_id, [...types].sort(), query.from, query.to]);
  const cursor = query.cursor === undefined ? null : decodeGraphCursor(query.cursor, fingerprint);
  const entity = toEntityRef(root);
  if (!changed && stored.length === 0) return { entity, items: [], nextCursor: null, freshness };
  const pathValue = (column: string) => pathMatch!.mode === "exact"
    ? sql<SqlBool>`${sql.ref(column)} = ${pathMatch!.value}`
    : valueMatches(column, { value: pathMatch!.value, mode: "under" });

  let page = db.selectFrom("brain_documents as d")
    .select(["d.document_id", ISO_MICROS("d.source_updated_at").as("at")])
    .where("d.owner_id", "=", scope.ownerId).where("d.scope_id", "=", scope.scopeId).where("d.deleted_at", "is", null)
    .where(({ or, exists, selectFrom }) => or([
      ...(changed ? [exists(selectFrom("brain_document_refs as r").select("r.document_id")
        .whereRef("r.owner_id", "=", "d.owner_id").whereRef("r.scope_id", "=", "d.scope_id")
        .whereRef("r.document_id", "=", "d.document_id").where("r.kind", "=", "path")
        .where(pathValue("r.value")))] : []),
      ...(stored.length > 0 ? [exists(selectFrom("brain_graph_links as l").select("l.link_id")
        .whereRef("l.owner_id", "=", "d.owner_id").whereRef("l.scope_id", "=", "d.scope_id")
        .whereRef("l.document_id", "=", "d.document_id").where("l.type", "in", stored)
        .where((eb) => eb.or([eb("l.from_entity_id", "in", members), eb("l.to_entity_id", "in", members)])))] : []),
    ]));
  if (query.from !== null) page = page.where("d.source_updated_at", ">=", query.from);
  if (query.to !== null) page = page.where("d.source_updated_at", "<", query.to);
  if (cursor !== null) {
    page = page.where(sql<SqlBool>`(d.source_updated_at, d.document_id) < (${cursor.at}::timestamptz, ${cursor.id})`);
  }
  const rows = await page.orderBy("d.source_updated_at", "desc").orderBy("d.document_id", "desc")
    .limit(query.limit + 1).execute();
  const items = rows.slice(0, query.limit);
  const ids = items.map((row) => row.document_id);
  const [linkRows, pathRows, cites] = await Promise.all([
    stored.length === 0 || ids.length === 0 ? [] : db.selectFrom("brain_graph_links as l")
      .select(["l.document_id", "l.type", "l.mode"]).where("l.owner_id", "=", scope.ownerId)
      .where("l.scope_id", "=", scope.scopeId).where("l.document_id", "in", ids).where("l.type", "in", stored)
      .where((eb) => eb.or([eb("l.from_entity_id", "in", members), eb("l.to_entity_id", "in", members)]))
      .limit(ids.length * BRAIN_GRAPH_LIMITS.linksPerDocument).execute(),
    !changed || ids.length === 0 ? [] : db.selectFrom("brain_document_refs as r").select(["r.document_id", "r.value"])
      .where("r.owner_id", "=", scope.ownerId).where("r.scope_id", "=", scope.scopeId).where("r.kind", "=", "path")
      .where("r.document_id", "in", ids).where(pathValue("r.value")).orderBy("r.value").limit(ids.length * 200)
      .execute(),
    loadBrainCites(db, scope, ids),
  ]);
  const last = rows.length > query.limit ? items[items.length - 1] : undefined;
  return {
    entity,
    items: items.flatMap((row) => {
      const cite = cites.get(row.document_id);
      if (cite === undefined) return [];
      const paths = pathRows.filter((path) => path.document_id === row.document_id).map((path) => path.value);
      const links = linkRows.filter((link) => link.document_id === row.document_id);
      const seen = new Set<string>([...(paths.length > 0 ? ["changed"] : []), ...links.map((link) => link.type)]);
      const explicit = paths.length > 0 || links.some((link) => link.mode === "explicit");
      return [{
        cite, linkTypes: BRAIN_LINK_TYPES.filter((type) => seen.has(type)),
        mode: explicit ? "explicit" as const : "inferred" as const,
        matchedPaths: paths.slice(0, BRAIN_GRAPH_LIMITS.matchedPathsMax),
      }];
    }),
    nextCursor: last === undefined ? null : encodeGraphCursor(fingerprint, last.at, last.document_id),
    freshness,
  };
}
