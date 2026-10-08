/**
 * Company Brain document read paths. Tombstones are excluded everywhere;
 * every query carries the (owner_id, scope_id) key. Reads take no lock.
 */
import { sql } from "kysely";
import type { BrainExecutor } from "./documents.js";
import { toBrainDocument, toBrainDocumentRevision, toBrainDocumentSummary } from "./mappers.js";
import {
  BRAIN_REVISIONS_PER_DOCUMENT,
  BrainStoreError,
  type BrainDocument,
  type BrainDocumentRevision,
  type BrainDocumentSummary,
  type BrainEvidenceProof,
  type BrainPage,
  type BrainScopeKey,
} from "./types.js";

const SUMMARY_COLUMNS = [
  "owner_id", "scope_id", "document_id", "source_id", "incarnation", "title", "permalink",
  "content_hash", "byte_count", "provenance", "revision", "source_updated_at", "published_at",
  "updated_at", "deleted_at",
] as const;

export async function readDocument(
  db: BrainExecutor,
  scope: BrainScopeKey,
  documentId: string,
): Promise<BrainDocument | null> {
  const row = await db.selectFrom("brain_documents").selectAll()
    .where("owner_id", "=", scope.ownerId)
    .where("scope_id", "=", scope.scopeId)
    .where("document_id", "=", documentId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  return row ? toBrainDocument(row) : null;
}

export async function listDocumentSummaries(
  db: BrainExecutor,
  scope: BrainScopeKey,
  options: { readonly limit: number; readonly cursor: string | null; readonly sourceId?: string },
): Promise<BrainPage<BrainDocumentSummary>> {
  let query = db.selectFrom("brain_documents").select(SUMMARY_COLUMNS)
    .where("owner_id", "=", scope.ownerId)
    .where("scope_id", "=", scope.scopeId)
    .where("deleted_at", "is", null);
  if (options.sourceId !== undefined) query = query.where("source_id", "=", options.sourceId);
  if (options.cursor !== null) query = query.where("document_id", ">", options.cursor);
  const rows = await query.orderBy("document_id", "asc").limit(options.limit + 1).execute();
  const page = rows.slice(0, options.limit);
  return {
    items: page.map(toBrainDocumentSummary),
    nextCursor: rows.length > options.limit ? page[page.length - 1]!.document_id : null,
  };
}

/** Plain full-text match over the partial GIN index; no ranking yet. */
export async function searchDocumentSummaries(
  db: BrainExecutor,
  scope: BrainScopeKey,
  input: { readonly query: string; readonly limit: number },
): Promise<readonly BrainDocumentSummary[]> {
  const rows = await db.selectFrom("brain_documents").select(SUMMARY_COLUMNS)
    .where("owner_id", "=", scope.ownerId)
    .where("scope_id", "=", scope.scopeId)
    .where("deleted_at", "is", null)
    .where(sql<boolean>`to_tsvector('simple', title || ' ' || body) @@ plainto_tsquery('simple', ${input.query})`)
    .orderBy("updated_at", "desc")
    .orderBy("document_id", "asc")
    .limit(input.limit)
    .execute();
  return rows.map(toBrainDocumentSummary);
}

export async function listDocumentRevisions(
  db: BrainExecutor,
  scope: BrainScopeKey,
  documentId: string,
): Promise<readonly BrainDocumentRevision[]> {
  const rows = await db.selectFrom("brain_document_revisions").selectAll()
    .where("owner_id", "=", scope.ownerId)
    .where("scope_id", "=", scope.scopeId)
    .where("document_id", "=", documentId)
    .orderBy("superseded_at", "desc")
    .orderBy("revision", "desc")
    .limit(BRAIN_REVISIONS_PER_DOCUMENT)
    .execute();
  return rows.map(toBrainDocumentRevision);
}

/** Every proof must match a live (document_id, incarnation, revision) triple exactly. */
export async function assertProofsCurrent(
  db: BrainExecutor,
  scope: BrainScopeKey,
  proofs: readonly BrainEvidenceProof[],
): Promise<void> {
  if (proofs.length === 0) return;
  const documentIds = proofs.map((proof) => proof.documentId)
    .filter((documentId, index, all) => all.indexOf(documentId) === index);
  const rows = await db.selectFrom("brain_documents")
    .select(["document_id", "incarnation", "revision"])
    .where("owner_id", "=", scope.ownerId)
    .where("scope_id", "=", scope.scopeId)
    .where("document_id", "in", documentIds)
    .where("deleted_at", "is", null)
    .execute();
  const current = proofs.every((proof) => rows.some((row) =>
    row.document_id === proof.documentId
    && row.incarnation === proof.incarnation
    && row.revision === proof.revision));
  if (!current) throw new BrainStoreError("forbidden");
}
