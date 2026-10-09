/**
 * Read-only core-table queries the brief parts share: current claims (read from the live revision of a live document)
 * with the document's status, due and assignee refs, and active sources. No locks; callers bound every query.
 */
import { sql, type Kysely } from "kysely";
import { BrainClaimFieldsSchema, type BrainClaimFields } from "../claims/types.js";
import type { BrainDatabase, BrainScopeKey } from "../types.js";
import { CALENDAR_DATE, parseUtcDate } from "./time.js";
import { BRIEF_SCANS, type BriefClaimRow } from "./types.js";

/** The smallest value of one ref kind of the claim's document `d`; due refs count only when they are calendar days. */
function documentRef(kind: "status" | "due" | "assignee") {
  const only = kind === "due" ? sql`r.value ~ ${CALENDAR_DATE.source}` : sql`TRUE`;
  return sql<string | null>`(SELECT min(r.value) FROM brain_document_refs r WHERE r.owner_id = d.owner_id
    AND r.scope_id = d.scope_id AND r.document_id = d.document_id AND r.kind = ${kind} AND ${only})`;
}

/** The document's status ref in SQL (its smallest value), as `currentClaims` selects it. */
export function documentStatus() {
  return documentRef("status");
}

/** A commitment's due date in SQL: the claim's own field, else the document's due ref (trackers put it there). */
export function commitmentDue() {
  const own = sql`c.fields->>'due'`;
  const date = CALENDAR_DATE.source;
  return sql<string | null>`COALESCE(CASE WHEN ${own} ~ ${date} THEN ${own} END, ${documentRef("due")})`;
}

/** Live documents `a` as of `at` (null: now): the row if dated before `at`, else its newest snapshot dated before it,
 * with when that version was stored (`written`) and replaced (`until`, null for the row). */
export function documentsAsOf(scope: BrainScopeKey, at: Date | null) {
  const end = at ?? sql`'infinity'::timestamptz`;
  return sql<{ document_id: string; dated: Date | string; revision: number; written: Date | string | null;
    until: Date | string | null; title: string; body: string }>`
    ((SELECT d.document_id, d.source_updated_at AS dated, d.revision, d.updated_at AS written,
      NULL::timestamptz AS until, d.title, d.body FROM brain_documents d WHERE d.owner_id = ${scope.ownerId}
      AND d.scope_id = ${scope.scopeId} AND d.deleted_at IS NULL AND d.source_updated_at < ${end})
    UNION ALL (SELECT DISTINCT ON (v.document_id) v.document_id, v.source_updated_at, v.revision,
      lag(v.superseded_at) OVER (PARTITION BY v.document_id ORDER BY v.revision), v.superseded_at, v.title, v.body
    FROM brain_document_revisions v JOIN brain_documents d ON d.owner_id = v.owner_id AND d.scope_id = v.scope_id
      AND d.document_id = v.document_id AND d.incarnation = v.incarnation AND d.deleted_at IS NULL
    WHERE v.owner_id = ${scope.ownerId} AND v.scope_id = ${scope.scopeId} AND d.source_updated_at >= ${end}
      AND v.source_updated_at < ${end} ORDER BY v.document_id, v.source_updated_at DESC, v.revision DESC))`.as("a");
}

/** Current claims as of `at` (documentsAsOf): of the live revision, or (read from a snapshot) written before it was
 * replaced; `source_updated_at` is that version's date. Callers add kind filters, order and limit. */
export function currentClaims(db: Kysely<BrainDatabase>, scope: BrainScopeKey, at: Date | null = null) {
  return db.selectFrom("brain_claims as c")
    .innerJoin("brain_documents as d", (join) => join.onRef("d.owner_id", "=", "c.owner_id")
      .onRef("d.scope_id", "=", "c.scope_id").onRef("d.document_id", "=", "c.document_id"))
    .innerJoin(documentsAsOf(scope, at), (join) => join.onRef("a.document_id", "=", "c.document_id"))
    .select([
      "c.claim_id", "c.kind", "c.label", "c.statement", "c.quote", "c.fields", "c.document_id", "d.source_id",
      "a.dated as source_updated_at", documentRef("status").as("status"), documentRef("due").as("due_ref"),
      documentRef("assignee").as("assignee_ref"),
    ])
    .where("c.owner_id", "=", scope.ownerId).where("c.scope_id", "=", scope.scopeId)
    .whereRef("c.incarnation", "=", "d.incarnation")
    .where((eb) => eb.or([eb.and([eb("a.until", "is", null), eb("c.revision", "=", eb.ref("d.revision"))]),
      eb("c.created_at", "<", eb.ref("a.until"))]));
}

/** Rules and model extractors can both hold a claim id; the first row of each id wins. */
export function uniqueClaims<T extends Pick<BriefClaimRow, "claim_id">>(rows: readonly T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.claim_id)) return false;
    seen.add(row.claim_id);
    return true;
  });
}

/** Stored fields are CHECKed on write; anything unreadable is treated as no fields. */
export function claimFields(row: Pick<BriefClaimRow, "fields">): BrainClaimFields {
  const parsed = BrainClaimFieldsSchema.safeParse(row.fields);
  return parsed.success ? parsed.data : {};
}

/** Due date and assignee: the claim's fields, else its document's refs. A due that is no calendar day is null. */
export function commitmentTerms(row: BriefClaimRow): { readonly due: string | null; readonly assignee: string | null } {
  const fields = claimFields(row);
  const due = fields.due ?? row.due_ref;
  const calendar = due !== null && parseUtcDate(due) !== null;
  return { due: calendar ? due : null, assignee: fields.assignee ?? row.assignee_ref };
}

export interface SourceState {
  readonly source_id: string; readonly kind: string; readonly label: string; readonly created_at: Date | string;
  readonly last_success: Date | string | null; readonly last_status: string | null;
  readonly last_finished: Date | string | null; readonly last_error: string | null;
  readonly newest_document: string | null;
}

/** Active live sources with their newest receipt, newest success and newest live document; `before` (a past brief):
 * only sources, receipts and documents from before it, and a receipt still running then has no finish. */
export async function sourceStates(
  db: Kysely<BrainDatabase>, scope: BrainScopeKey, before: Date | null,
): Promise<SourceState[]> {
  const cut = (column: string) => (before === null ? sql`` : sql`AND ${sql.ref(column)} < ${before}`);
  const finished = before === null ? sql`r.finished_at`
    : sql`CASE WHEN r.finished_at < ${before} THEN r.finished_at END`;
  const { rows } = await sql<SourceState>`
    SELECT s.source_id, s.kind, s.label, s.created_at,
      (SELECT max(r.finished_at) FROM brain_sync_receipts r WHERE r.owner_id = s.owner_id AND r.scope_id = s.scope_id
        AND r.source_id = s.source_id AND r.status IN ('succeeded', 'partial') ${cut("r.finished_at")}) AS last_success,
      n.status AS last_status, n.finished_at AS last_finished, n.error_code AS last_error,
      (SELECT d.document_id FROM brain_documents d WHERE d.owner_id = s.owner_id AND d.scope_id = s.scope_id
        AND d.source_id = s.source_id AND d.deleted_at IS NULL ${cut("d.source_updated_at")}
        ORDER BY d.source_updated_at DESC, d.document_id DESC LIMIT 1) AS newest_document
    FROM brain_sources s
    LEFT JOIN LATERAL (SELECT r.status, ${finished} AS finished_at, r.error_code FROM brain_sync_receipts r
      WHERE r.owner_id = s.owner_id AND r.scope_id = s.scope_id AND r.source_id = s.source_id ${cut("r.started_at")}
      ORDER BY r.started_at DESC, r.receipt_id DESC LIMIT 1) n ON TRUE
    WHERE s.owner_id = ${scope.ownerId} AND s.scope_id = ${scope.scopeId} AND s.deleted_at IS NULL
      AND s.status = 'active' ${cut("s.created_at")}
    ORDER BY s.created_at, s.source_id
    LIMIT ${BRIEF_SCANS.sources}`.execute(db);
  return rows;
}
