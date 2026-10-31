/**
 * Company Brain sync cursor and receipt primitives. Write functions expect a
 * transaction that already holds the per-scope advisory lock. The cursor's
 * only writer is applySyncBatch, so it always describes committed documents.
 */
import { sql } from "kysely";
import { createBrainReceiptId, type BrainExecutor } from "./documents.js";
import { toBrainSyncCursor, toBrainSyncReceipt, type BrainCursorRow } from "./mappers.js";
import {
  BRAIN_RECEIPTS_PER_SOURCE,
  BrainStoreError,
  type BrainScopeKey,
  type BrainSyncCounts,
  type BrainSyncCursor,
  type BrainSyncReceipt,
  type BrainSyncReceiptOutcome,
} from "./types.js";

const conflict = (): BrainStoreError => new BrainStoreError("conflict");

export function selectCursor(
  db: BrainExecutor,
  scope: BrainScopeKey,
  sourceId: string,
): Promise<BrainCursorRow | undefined> {
  return db.selectFrom("brain_sync_cursors").selectAll()
    .where("owner_id", "=", scope.ownerId)
    .where("scope_id", "=", scope.scopeId)
    .where("source_id", "=", sourceId)
    .executeTakeFirst();
}

/** Cursor CAS lives in the write predicate; a miss throws conflict and rolls the batch back. */
export async function advanceCursor(
  db: BrainExecutor,
  scope: BrainScopeKey,
  batch: { readonly sourceId: string; readonly expectedCursor: string | null; readonly nextCursor: string },
  now: Date,
): Promise<BrainSyncCursor> {
  const row = batch.expectedCursor === null
    ? await db.insertInto("brain_sync_cursors")
      .values({
        owner_id: scope.ownerId, scope_id: scope.scopeId, source_id: batch.sourceId, cursor: batch.nextCursor, updated_at: now,
      })
      .onConflict((oc) => oc.columns(["owner_id", "scope_id", "source_id"]).doNothing())
      .returningAll()
      .executeTakeFirstOrThrow(conflict)
    : await db.updateTable("brain_sync_cursors")
      .set({ cursor: batch.nextCursor, updated_at: now })
      .where("owner_id", "=", scope.ownerId)
      .where("scope_id", "=", scope.scopeId)
      .where("source_id", "=", batch.sourceId)
      .where("cursor", "=", batch.expectedCursor)
      .returningAll()
      .executeTakeFirstOrThrow(conflict);
  return toBrainSyncCursor(row);
}

/** Closes any lingering running receipt as interrupted, opens a new one, prunes to the retention cap. */
export async function openReceipt(
  db: BrainExecutor,
  scope: BrainScopeKey,
  sourceId: string,
  now: Date,
): Promise<BrainSyncReceipt> {
  await db.updateTable("brain_sync_receipts")
    .set({ status: "interrupted", finished_at: now })
    .where("owner_id", "=", scope.ownerId)
    .where("scope_id", "=", scope.scopeId)
    .where("source_id", "=", sourceId)
    .where("status", "=", "running")
    .execute();
  const cursor = await selectCursor(db, scope, sourceId);
  const opened = await db.insertInto("brain_sync_receipts").values({
    owner_id: scope.ownerId,
    scope_id: scope.scopeId,
    source_id: sourceId,
    receipt_id: createBrainReceiptId(),
    status: "running",
    error_code: null,
    cursor_before: cursor?.cursor ?? null,
    cursor_after: null,
    started_at: now,
    finished_at: null,
  }).returningAll().executeTakeFirstOrThrow();
  await sql`
    DELETE FROM brain_sync_receipts WHERE ctid IN (
      SELECT ctid FROM brain_sync_receipts
      WHERE owner_id = ${scope.ownerId} AND scope_id = ${scope.scopeId} AND source_id = ${sourceId}
        AND status <> 'running'
      ORDER BY started_at DESC, receipt_id DESC
      OFFSET ${BRAIN_RECEIPTS_PER_SOURCE - 1}
    )
  `.execute(db);
  return toBrainSyncReceipt(opened);
}

export async function closeReceipt(
  db: BrainExecutor,
  scope: BrainScopeKey,
  close: {
    readonly sourceId: string;
    readonly receiptId: string;
    readonly status: BrainSyncReceiptOutcome;
    readonly counts: BrainSyncCounts;
    readonly nextAction?: string;
    readonly errorCode?: string | null;
  },
  now: Date,
): Promise<BrainSyncReceipt> {
  const receipt = await db.selectFrom("brain_sync_receipts").select("status")
    .where("owner_id", "=", scope.ownerId)
    .where("scope_id", "=", scope.scopeId)
    .where("source_id", "=", close.sourceId)
    .where("receipt_id", "=", close.receiptId)
    .executeTakeFirst();
  if (!receipt) throw new BrainStoreError("not_found");
  if (receipt.status !== "running") throw conflict();
  const cursor = await selectCursor(db, scope, close.sourceId);
  const closed = await db.updateTable("brain_sync_receipts").set({
    status: close.status,
    read_count: close.counts.read,
    written_count: close.counts.written,
    unchanged_count: close.counts.unchanged,
    deleted_count: close.counts.deleted,
    failed_count: close.counts.failed,
    next_action: close.nextAction ?? "",
    error_code: close.errorCode ?? null,
    cursor_after: cursor?.cursor ?? null,
    finished_at: now,
  })
    .where("owner_id", "=", scope.ownerId)
    .where("scope_id", "=", scope.scopeId)
    .where("source_id", "=", close.sourceId)
    .where("receipt_id", "=", close.receiptId)
    .where("status", "=", "running")
    .returningAll()
    .executeTakeFirstOrThrow(conflict);
  return toBrainSyncReceipt(closed);
}

export async function listReceipts(
  db: BrainExecutor,
  scope: BrainScopeKey,
  sourceId: string,
  limit: number,
): Promise<readonly BrainSyncReceipt[]> {
  const rows = await db.selectFrom("brain_sync_receipts").selectAll()
    .where("owner_id", "=", scope.ownerId)
    .where("scope_id", "=", scope.scopeId)
    .where("source_id", "=", sourceId)
    .orderBy("started_at", "desc")
    .orderBy("receipt_id", "desc")
    .limit(limit)
    .execute();
  return rows.map(toBrainSyncReceipt);
}
