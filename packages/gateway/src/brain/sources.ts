/**
 * Company Brain source primitives. Write functions expect a transaction that
 * already holds the per-scope advisory lock; every statement carries the
 * (owner_id, scope_id) key. A source is only ever tombstoned here; physical
 * deletion is eraseScope's job.
 */
import { sql } from "kysely";
import { deleteClaimData } from "./claims/store.js";
import { deleteSourceDocumentRefs } from "./document-refs.js";
import { createBrainSourceId, tombstoneFields, type BrainExecutor } from "./documents.js";
import { toBrainSource, type BrainSourceRow } from "./mappers.js";
import {
  BrainStoreError,
  type BrainCreateSourceResult,
  type BrainPage,
  type BrainScopeKey,
  type BrainSource,
  type BrainSourceStatus,
} from "./types.js";

export function selectLiveSource(
  db: BrainExecutor,
  scope: BrainScopeKey,
  sourceId: string,
): Promise<BrainSourceRow | undefined> {
  return db.selectFrom("brain_sources").selectAll()
    .where("owner_id", "=", scope.ownerId)
    .where("scope_id", "=", scope.scopeId)
    .where("source_id", "=", sourceId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
}

/** The source must be live and active to accept sync writes. */
export async function requireActiveSource(
  db: BrainExecutor,
  scope: BrainScopeKey,
  sourceId: string,
): Promise<BrainSourceRow> {
  const row = await selectLiveSource(db, scope, sourceId);
  if (!row) throw new BrainStoreError("not_found");
  if (row.status !== "active") throw new BrainStoreError("conflict");
  return row;
}

/** After a CAS miss: missing or tombstoned is not_found, otherwise the revision was stale. */
async function sourceWriteFailure(db: BrainExecutor, scope: BrainScopeKey, sourceId: string): Promise<BrainStoreError> {
  const row = await selectLiveSource(db, scope, sourceId);
  return new BrainStoreError(row ? "conflict" : "not_found");
}

/** Idempotent on the live (kind, external_ref) key; a duplicate returns the existing row unchanged. */
export async function insertSource(
  db: BrainExecutor,
  scope: BrainScopeKey,
  input: { readonly kind: string; readonly externalRef: string; readonly label: string; readonly status?: BrainSourceStatus },
  now: Date,
): Promise<BrainCreateSourceResult> {
  const inserted = await db.insertInto("brain_sources").values({
    owner_id: scope.ownerId,
    scope_id: scope.scopeId,
    source_id: createBrainSourceId(),
    kind: input.kind,
    external_ref: input.externalRef,
    label: input.label,
    status: input.status ?? "active",
    revision: 1,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  })
    .onConflict((oc) => oc
      .columns(["owner_id", "scope_id", "kind", "external_ref"])
      .where("deleted_at", "is", null)
      .doNothing())
    .returningAll()
    .executeTakeFirst();
  if (inserted) return { source: toBrainSource(inserted), created: true };
  const existing = await db.selectFrom("brain_sources").selectAll()
    .where("owner_id", "=", scope.ownerId)
    .where("scope_id", "=", scope.scopeId)
    .where("kind", "=", input.kind)
    .where("external_ref", "=", input.externalRef)
    .where("deleted_at", "is", null)
    .executeTakeFirstOrThrow();
  return { source: toBrainSource(existing), created: false };
}

export async function listSourcePage(
  db: BrainExecutor,
  scope: BrainScopeKey,
  page: { readonly limit: number; readonly cursor: string | null },
): Promise<BrainPage<BrainSource>> {
  let query = db.selectFrom("brain_sources").selectAll()
    .where("owner_id", "=", scope.ownerId)
    .where("scope_id", "=", scope.scopeId)
    .where("deleted_at", "is", null);
  if (page.cursor !== null) query = query.where("source_id", ">", page.cursor);
  const rows = await query.orderBy("source_id", "asc").limit(page.limit + 1).execute();
  const items = rows.slice(0, page.limit);
  return {
    items: items.map(toBrainSource),
    nextCursor: rows.length > page.limit ? items[items.length - 1]!.source_id : null,
  };
}

export async function updateSourceRow(
  db: BrainExecutor,
  scope: BrainScopeKey,
  patch: { readonly sourceId: string; readonly expectedRevision: number; readonly label?: string; readonly status?: BrainSourceStatus },
  now: Date,
): Promise<BrainSource> {
  const updated = await db.updateTable("brain_sources").set({
    ...(patch.label !== undefined ? { label: patch.label } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    revision: patch.expectedRevision + 1,
    updated_at: now,
  })
    .where("owner_id", "=", scope.ownerId)
    .where("scope_id", "=", scope.scopeId)
    .where("source_id", "=", patch.sourceId)
    .where("revision", "=", patch.expectedRevision)
    .where("deleted_at", "is", null)
    .returningAll()
    .executeTakeFirst();
  if (!updated) throw await sourceWriteFailure(db, scope, patch.sourceId);
  return toBrainSource(updated);
}

/**
 * Tombstones the source, purges every snapshot it ever contributed (by the
 * snapshot's own source_id, and by the documents it currently owns),
 * bulk-tombstones its live documents without snapshots (the content must not
 * linger), closes a running receipt as interrupted, and drops its cursor.
 * Receipts are metadata and stay.
 */
export async function tombstoneSource(
  db: BrainExecutor,
  scope: BrainScopeKey,
  target: { readonly sourceId: string; readonly expectedRevision: number },
  now: Date,
): Promise<BrainSource> {
  const deleted = await db.updateTable("brain_sources")
    .set({ deleted_at: now, updated_at: now, revision: target.expectedRevision + 1 })
    .where("owner_id", "=", scope.ownerId)
    .where("scope_id", "=", scope.scopeId)
    .where("source_id", "=", target.sourceId)
    .where("revision", "=", target.expectedRevision)
    .where("deleted_at", "is", null)
    .returningAll()
    .executeTakeFirst();
  if (!deleted) throw await sourceWriteFailure(db, scope, target.sourceId);
  // A document id re-incarnated under another source still carries this
  // source's earlier snapshots; the snapshot's own source_id finds those.
  await db.deleteFrom("brain_document_revisions")
    .where("owner_id", "=", scope.ownerId)
    .where("scope_id", "=", scope.scopeId)
    .where((eb) => eb.or([
      eb("source_id", "=", target.sourceId),
      eb("document_id", "in", eb.selectFrom("brain_documents").select("document_id")
        .where("owner_id", "=", scope.ownerId)
        .where("scope_id", "=", scope.scopeId)
        .where("source_id", "=", target.sourceId)),
    ]))
    .execute();
  await deleteSourceDocumentRefs(db, scope, target.sourceId);
  await deleteClaimData(db, scope, { sourceId: target.sourceId });
  await db.updateTable("brain_documents")
    .set({ ...tombstoneFields(now), revision: sql`revision + 1` })
    .where("owner_id", "=", scope.ownerId)
    .where("scope_id", "=", scope.scopeId)
    .where("source_id", "=", target.sourceId)
    .where("deleted_at", "is", null)
    .execute();
  // Nothing will ever open another receipt for this source, so a crashed run
  // must be closed here rather than by the next openSyncReceipt.
  await db.updateTable("brain_sync_receipts")
    .set({ status: "interrupted", finished_at: now })
    .where("owner_id", "=", scope.ownerId)
    .where("scope_id", "=", scope.scopeId)
    .where("source_id", "=", target.sourceId)
    .where("status", "=", "running")
    .execute();
  await db.deleteFrom("brain_sync_cursors")
    .where("owner_id", "=", scope.ownerId)
    .where("scope_id", "=", scope.scopeId)
    .where("source_id", "=", target.sourceId)
    .execute();
  return toBrainSource(deleted);
}
