/**
 * Ref matching: live documents with a ref of one kind equal to or under a value (a repository file or folder), newest
 * source_updated_at first, keyset paged, with a capped total. brain_document_refs.value is COLLATE "C", so "starts
 * with v/" is the bytewise range [v + "/", v + "0") ("0" is the byte after "/"), served by brain_document_refs_lookup.
 * No LIKE, so nothing to escape; values are bound parameters. Reads take no lock.
 */
import { sql, type Expression, type SqlBool } from "kysely";
import { z } from "zod/v4";
import type { BrainExecutor } from "./documents.js";
import { toBrainDocument } from "./mappers.js";
import { BrainDocumentIdSchema, parseBrainInput } from "./schemas.js";
import {
  BRAIN_DOCUMENT_REFS_MAX, BRAIN_REF_MATCH_COUNT_CAP, BrainStoreError, type BrainDocumentRef, type BrainRefMatchPage,
  type BrainRefMatchQuery, type BrainScopeKey,
} from "./types.js";

/** A BrainRefMatchQuery after BrainRefMatchQuerySchema (defaults applied). */
export type BrainRefMatchParsedQuery = Required<Omit<BrainRefMatchQuery, "cursor">> & {
  readonly cursor: string | null;
};

export interface BrainRefMatchCursor {
  /** source_updated_at in UTC with microseconds, so the keyset is exact for any stored timestamp. */
  readonly at: string;
  readonly documentId: string;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** Exactly what encodeRefMatchCursor writes: a JSON array of two strings without quotes or escapes inside. */
const CURSOR_JSON = /^\["([^"\\]+)","([^"\\]+)"\]$/;
/** Postgres has no year 0, so a year-0000 time would fail in SQL instead of reading as a bad cursor. */
const CursorTupleSchema = z.tuple([
  z.iso.datetime({ precision: 6 }).refine((at) => !at.startsWith("0000-")), BrainDocumentIdSchema,
]);

export function encodeRefMatchCursor(cursor: BrainRefMatchCursor): string {
  return Buffer.from(JSON.stringify([cursor.at, cursor.documentId]), "utf8").toString("base64url");
}

/** base64url of JSON `[ISO-8601 UTC with 6 fraction digits, 64-hex id]`; anything else is BrainStoreError("invalid"). */
export function decodeRefMatchCursor(cursor: string): BrainRefMatchCursor {
  const parts = BASE64URL.test(cursor) ? CURSOR_JSON.exec(Buffer.from(cursor, "base64url").toString("utf8")) : null;
  if (parts === null) throw new BrainStoreError("invalid");
  const [at, documentId] = parseBrainInput(CursorTupleSchema, [parts[1], parts[2]]);
  return { at, documentId };
}

/** `column` equals the value (exact_or_under only) or starts with value + "/". */
export function valueMatches(
  column: string,
  query: Pick<BrainRefMatchParsedQuery, "value" | "mode">,
): Expression<SqlBool> {
  const ref = sql.ref(column);
  const under = sql<SqlBool>`(${ref} >= ${`${query.value}/`} AND ${ref} < ${`${query.value}0`})`;
  return query.mode === "under" ? under : sql<SqlBool>`(${ref} = ${query.value} OR ${under})`;
}

/** Live documents of the scope with an allowed provenance and at least one matching ref; each document once. */
function matchingDocuments(db: BrainExecutor, scope: BrainScopeKey, query: BrainRefMatchParsedQuery) {
  return db.selectFrom("brain_documents as d")
    .where("d.owner_id", "=", scope.ownerId)
    .where("d.scope_id", "=", scope.scopeId)
    .where("d.deleted_at", "is", null)
    .where("d.provenance", "in", [...query.provenances])
    .where(({ exists, selectFrom }) => exists(selectFrom("brain_document_refs as r").select("r.document_id")
      .whereRef("r.owner_id", "=", "d.owner_id")
      .whereRef("r.scope_id", "=", "d.scope_id")
      .whereRef("r.document_id", "=", "d.document_id")
      .where("r.kind", "=", query.kind)
      .where(valueMatches("r.value", query))));
}

async function countMatches(
  db: BrainExecutor,
  scope: BrainScopeKey,
  query: BrainRefMatchParsedQuery,
  countCap: number,
): Promise<number> {
  const bounded = matchingDocuments(db, scope, query).select("d.document_id").limit(countCap + 1).as("m");
  const row = await db.selectFrom(bounded).select((eb) => eb.fn.countAll().as("n")).executeTakeFirstOrThrow();
  return Number(row.n);
}

/**
 * Matching refs of the query kind plus every ref of extraRefKinds, grouped per document, by kind then value. A
 * document holds at most BRAIN_DOCUMENT_REFS_MAX refs (applySyncBatch replaces the set), so the limit bounds the read.
 */
async function selectPageRefs(
  db: BrainExecutor,
  scope: BrainScopeKey,
  query: BrainRefMatchParsedQuery,
  documentIds: readonly string[],
): Promise<Map<string, BrainDocumentRef[]>> {
  const grouped = new Map<string, BrainDocumentRef[]>();
  if (documentIds.length === 0) return grouped;
  const rows = await db.selectFrom("brain_document_refs as r").select(["r.document_id", "r.kind", "r.value"])
    .where("r.owner_id", "=", scope.ownerId)
    .where("r.scope_id", "=", scope.scopeId)
    .where("r.document_id", "in", [...documentIds])
    .where((eb) => {
      const matched = eb.and([eb("r.kind", "=", query.kind), valueMatches("r.value", query)]);
      return query.extraRefKinds.length === 0 ? matched : eb.or([matched, eb("r.kind", "in", [...query.extraRefKinds])]);
    })
    .orderBy("r.document_id", "asc")
    .orderBy("r.kind", "asc")
    .orderBy("r.value", "asc")
    .limit(documentIds.length * BRAIN_DOCUMENT_REFS_MAX)
    .execute();
  for (const row of rows) {
    const refs = grouped.get(row.document_id) ?? [];
    refs.push({ kind: row.kind, value: row.value });
    grouped.set(row.document_id, refs);
  }
  return grouped;
}

/**
 * One page of matches. The total is counted on every page, independent of
 * the cursor; `countCap` is a parameter so tests can reach the cap cheaply.
 * Memory: at most limit + 1 documents (64 KiB each) and limit x 200 ref rows.
 */
export async function selectDocumentsByRef(
  db: BrainExecutor,
  scope: BrainScopeKey,
  query: BrainRefMatchParsedQuery,
  countCap: number = BRAIN_REF_MATCH_COUNT_CAP,
): Promise<BrainRefMatchPage> {
  const cursor = query.cursor === null ? null : decodeRefMatchCursor(query.cursor);
  let pageQuery = matchingDocuments(db, scope, query).selectAll("d")
    .select(sql<string>`to_char(${sql.ref("d.source_updated_at")} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
      .as("cursor_at"));
  if (cursor !== null) {
    pageQuery = pageQuery.where(sql<SqlBool>`(${sql.ref("d.source_updated_at")}, ${sql.ref("d.document_id")})
      < (${cursor.at}::timestamptz, ${cursor.documentId})`);
  }
  const [rows, total] = await Promise.all([
    pageQuery.orderBy("d.source_updated_at", "desc").orderBy("d.document_id", "desc").limit(query.limit + 1).execute(),
    countMatches(db, scope, query, countCap),
  ]);
  const page = rows.slice(0, query.limit);
  const refs = await selectPageRefs(db, scope, query, page.map((row) => row.document_id));
  const last = rows.length > query.limit ? page[page.length - 1] : undefined;
  return {
    items: page.map((row) => ({ document: toBrainDocument(row), refs: refs.get(row.document_id) ?? [] })),
    nextCursor: last === undefined ? null : encodeRefMatchCursor({ at: last.cursor_at, documentId: last.document_id }),
    total: Math.min(total, countCap),
    totalCapped: total > countCap,
  };
}
