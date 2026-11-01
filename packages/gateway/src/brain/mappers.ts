/**
 * Row-to-domain mappers for the Company Brain store. Timestamps leave the
 * store as ISO-8601 strings. Nothing here touches the database.
 */
import type { Selectable } from "kysely";
import type {
  BrainCitation,
  BrainDocument,
  BrainDocumentRevision,
  BrainDocumentRevisionsTable,
  BrainDocumentSummary,
  BrainDocumentsTable,
  BrainSource,
  BrainSourcesTable,
  BrainSyncCursor,
  BrainSyncCursorsTable,
  BrainSyncReceipt,
  BrainSyncReceiptsTable,
} from "./types.js";

export type BrainDocumentRow = Selectable<BrainDocumentsTable>;
export type BrainDocumentSummaryRow = Omit<BrainDocumentRow, "body">;
export type BrainSourceRow = Selectable<BrainSourcesTable>;
export type BrainCursorRow = Selectable<BrainSyncCursorsTable>;
export type BrainReceiptRow = Selectable<BrainSyncReceiptsTable>;

export function asIso(value: Date | string): string {
  return new Date(value).toISOString();
}

export function asNullableIso(value: Date | string | null): string | null {
  return value === null ? null : asIso(value);
}

export function toBrainCitation(row: BrainDocumentSummaryRow): BrainCitation {
  return {
    documentId: row.document_id,
    scopeId: row.scope_id,
    revision: row.revision,
    incarnation: row.incarnation,
    permalink: row.permalink,
    sourceUpdatedAt: asIso(row.source_updated_at),
    publishedAt: asIso(row.published_at),
  };
}

export function toBrainDocumentSummary(row: BrainDocumentSummaryRow): BrainDocumentSummary {
  return {
    ...toBrainCitation(row),
    ownerId: row.owner_id,
    sourceId: row.source_id,
    title: row.title,
    provenance: row.provenance,
    contentHash: row.content_hash,
    byteCount: row.byte_count,
    updatedAt: asIso(row.updated_at),
    deletedAt: asNullableIso(row.deleted_at),
  };
}

export function toBrainDocument(row: BrainDocumentRow): BrainDocument {
  return { ...toBrainDocumentSummary(row), body: row.body };
}

export function toBrainDocumentRevision(row: Selectable<BrainDocumentRevisionsTable>): BrainDocumentRevision {
  return {
    scopeId: row.scope_id,
    documentId: row.document_id,
    incarnation: row.incarnation,
    revision: row.revision,
    change: row.change,
    title: row.title,
    body: row.body,
    permalink: row.permalink,
    provenance: row.provenance,
    contentHash: row.content_hash,
    byteCount: row.byte_count,
    sourceUpdatedAt: asIso(row.source_updated_at),
    supersededAt: asIso(row.superseded_at),
  };
}

export function toBrainSource(row: BrainSourceRow): BrainSource {
  return {
    scopeId: row.scope_id,
    ownerId: row.owner_id,
    sourceId: row.source_id,
    kind: row.kind,
    externalRef: row.external_ref,
    label: row.label,
    status: row.status,
    revision: row.revision,
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
    deletedAt: asNullableIso(row.deleted_at),
  };
}

export function toBrainSyncCursor(row: BrainCursorRow): BrainSyncCursor {
  return { scopeId: row.scope_id, sourceId: row.source_id, cursor: row.cursor, updatedAt: asIso(row.updated_at) };
}

export function toBrainSyncReceipt(row: BrainReceiptRow): BrainSyncReceipt {
  return {
    scopeId: row.scope_id,
    sourceId: row.source_id,
    receiptId: row.receipt_id,
    status: row.status,
    counts: {
      read: row.read_count,
      written: row.written_count,
      unchanged: row.unchanged_count,
      deleted: row.deleted_count,
      failed: row.failed_count,
    },
    nextAction: row.next_action,
    errorCode: row.error_code,
    cursorBefore: row.cursor_before,
    cursorAfter: row.cursor_after,
    startedAt: asIso(row.started_at),
    finishedAt: asNullableIso(row.finished_at),
  };
}
