/**
 * Claims of live documents, newest document first, keyset paged, with stale: true when the document has moved past the
 * claim's (incarnation, revision). Claims of another rules version read only while the current rules version has no
 * state for their document. The path filter reuses refs-reads.ts's bytewise range (no LIKE). No lock.
 */
import { sql, type Kysely, type SqlBool } from "kysely";
import { z } from "zod/v4";
import { asIso } from "../mappers.js";
import { valueMatches } from "../refs-reads.js";
import { BrainDocumentIdSchema, parseBrainInput } from "../schemas.js";
import { BrainStoreError, type BrainDatabase, type BrainScopeKey } from "../types.js";
import { BrainClaimIdSchema, BrainExtractorIdSchema, type BrainParsedClaimListQuery } from "./schemas.js";
import { BRAIN_RULES_EXTRACTOR_LIKE } from "./store.js";
import {
  BRAIN_CLAIM_FOOTER_PROVENANCES, BRAIN_CLAIM_FOOTER_TAIL_CHARS, BRAIN_CLAIM_SPAN_MAX, BRAIN_RULES_EXTRACTOR_ID,
  BrainClaimFieldsSchema, type BrainClaimPage,
} from "./types.js";

const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** Exactly what the encoder writes: JSON [at, documentId, spanStart, claimId, extractor] with no quotes or escapes. */
const CURSOR_JSON = /^\["([^"\\]+)","([^"\\]+)",(\d{1,5}),"([^"\\]+)","([^"\\]+)"\]$/;
/** at: source_updated_at in UTC with microseconds; Postgres has no year 0, so a year-0000 time is a bad cursor. */
const CursorTupleSchema = z.tuple([
  z.iso.datetime({ precision: 6 }).refine((at) => !at.startsWith("0000-")), BrainDocumentIdSchema,
  z.number().int().max(BRAIN_CLAIM_SPAN_MAX), BrainClaimIdSchema, BrainExtractorIdSchema,
]);
/** The fields CHECK and write-time zod make a mismatch impossible; an empty object is the safe reading anyway. */
const StoredFieldsSchema = BrainClaimFieldsSchema.catch({});

/** Anything but what selectClaims encodes is BrainStoreError("invalid"). */
function decodeClaimCursor(cursor: string): z.output<typeof CursorTupleSchema> {
  const parts = BASE64URL.test(cursor) ? CURSOR_JSON.exec(Buffer.from(cursor, "base64url").toString("utf8")) : null;
  if (parts === null) throw new BrainStoreError("invalid");
  return parseBrainInput(CursorTupleSchema, [parts[1], parts[2], Number(parts[3]), parts[4], parts[5]]);
}

export async function selectClaims(
  db: Kysely<BrainDatabase>, scope: BrainScopeKey, query: BrainParsedClaimListQuery,
): Promise<BrainClaimPage> {
  const cursor = query.cursor === null ? null : decodeClaimCursor(query.cursor);
  let page = db.selectFrom("brain_claims as c")
    .innerJoin("brain_documents as d", (join) => join.onRef("d.owner_id", "=", "c.owner_id")
      .onRef("d.scope_id", "=", "c.scope_id").onRef("d.document_id", "=", "c.document_id"))
    .selectAll("c")
    .select([
      "d.title", "d.permalink", "d.provenance", "d.source_updated_at",
      "d.revision as live_revision", "d.incarnation as live_incarnation",
      sql<string>`to_char(${sql.ref("d.source_updated_at")} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
        .as("cursor_at"),
      sql<string | null>`CASE WHEN ${sql.ref("d.provenance")} IN (${sql.join(BRAIN_CLAIM_FOOTER_PROVENANCES)})
        THEN right(${sql.ref("d.body")}, ${BRAIN_CLAIM_FOOTER_TAIL_CHARS}::int) ELSE NULL END`.as("body_tail"),
    ])
    .where("c.owner_id", "=", scope.ownerId).where("c.scope_id", "=", scope.scopeId).where("d.deleted_at", "is", null)
    // The current rules version's write removes a document's other rules rows; this also keeps out rows that an older
    // gateway wrote after it, until the next rules run clears them.
    .where((eb) => eb.or([
      eb("c.extractor", "not like", BRAIN_RULES_EXTRACTOR_LIKE), eb("c.extractor", "=", BRAIN_RULES_EXTRACTOR_ID),
      eb.not(eb.exists(eb.selectFrom("brain_extraction_state as s").select("s.document_id")
        .whereRef("s.owner_id", "=", "c.owner_id").whereRef("s.scope_id", "=", "c.scope_id")
        .whereRef("s.document_id", "=", "c.document_id").where("s.extractor", "=", BRAIN_RULES_EXTRACTOR_ID))),
    ]));
  if (query.kind !== undefined) page = page.where("c.kind", "=", query.kind);
  const path = query.path;
  if (path !== undefined) {
    page = page.where(({ exists, selectFrom }) => exists(selectFrom("brain_document_refs as r").select("r.document_id")
      .whereRef("r.owner_id", "=", "d.owner_id").whereRef("r.scope_id", "=", "d.scope_id")
      .whereRef("r.document_id", "=", "d.document_id").where("r.kind", "=", "path")
      .where(valueMatches("r.value", path))));
  }
  if (cursor !== null) {
    const [cursorAt, cursorDocument, spanStart, claimId, extractor] = cursor;
    const at = sql`${cursorAt}::timestamptz`;
    const updated = sql.ref("d.source_updated_at");
    const documentId = sql.ref("d.document_id");
    page = page.where(sql<SqlBool>`(${updated} < ${at}
      OR (${updated} = ${at} AND ${documentId} < ${cursorDocument})
      OR (${updated} = ${at} AND ${documentId} = ${cursorDocument}
        AND (${sql.ref("c.span_start")}, ${sql.ref("c.claim_id")}, ${sql.ref("c.extractor")})
          > (${spanStart}::int, ${claimId}, ${extractor})))`);
  }
  const rows = await page
    .orderBy("d.source_updated_at", "desc").orderBy("d.document_id", "desc")
    .orderBy("c.span_start", "asc").orderBy("c.claim_id", "asc").orderBy("c.extractor", "asc")
    .limit(query.limit + 1).execute();
  const items = rows.slice(0, query.limit);
  const last = rows.length > query.limit ? items[items.length - 1] : undefined;
  return {
    items: items.map((row) => ({
      claim: {
        claimId: row.claim_id, kind: row.kind, label: row.label, statement: row.statement, quote: row.quote,
        spanStart: row.span_start, spanEnd: row.span_end, fields: StoredFieldsSchema.parse(row.fields),
        confidence: row.confidence, documentId: row.document_id, extractor: row.extractor,
        incarnation: row.incarnation, revision: row.revision, createdAt: asIso(row.created_at),
        stale: row.revision !== row.live_revision || row.incarnation !== row.live_incarnation,
      },
      document: {
        documentId: row.document_id, provenance: row.provenance, title: row.title, permalink: row.permalink,
        revision: row.live_revision, sourceUpdatedAt: asIso(row.source_updated_at), bodyTail: row.body_tail,
      },
    })),
    nextCursor: last === undefined ? null : Buffer.from(JSON.stringify([
      last.cursor_at, last.document_id, last.span_start, last.claim_id, last.extractor,
    ]), "utf8").toString("base64url"),
  };
}
