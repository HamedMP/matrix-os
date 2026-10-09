/**
 * Company Brain document write primitives. Pure functions over a Kysely
 * executor (a transaction for writes); BrainRepository calls them under the
 * per-scope advisory lock. Every statement carries the (owner_id, scope_id)
 * key. Read paths live in document-reads.ts.
 */
import { createHash, randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import { deleteClaimData } from "./claims/store.js";
import { deleteDocumentRefs } from "./document-refs.js";
import { toBrainDocument, type BrainDocumentRow } from "./mappers.js";
import {
  BRAIN_DOCUMENT_MAX_BYTES,
  BRAIN_REVISIONS_PER_DOCUMENT,
  BrainStoreError,
  type BrainDatabase,
  type BrainDocument,
  type BrainDocumentChange,
  type BrainDocumentContentInput,
  type BrainScopeKey,
  type BrainUpsertDocumentResult,
} from "./types.js";

export type BrainExecutor = Kysely<BrainDatabase> | Transaction<BrainDatabase>;

export interface BrainCapacityLimits {
  readonly maxDocumentsPerScope: number;
  readonly maxBytesPerScope: number;
}

/** Live totals for one scope, tracked incrementally while a write proceeds. */
export interface BrainCapacity {
  count: number;
  bytes: number;
}

export interface BrainWriteContext {
  readonly db: BrainExecutor;
  readonly scope: BrainScopeKey;
  readonly now: Date;
  readonly limits: BrainCapacityLimits;
  readonly capacity: BrainCapacity;
}

export interface BrainApplyUpsertInput extends BrainDocumentContentInput {
  readonly sourceId: string | null;
  readonly expectedRevision?: number;
}

export interface BrainApplyReviseInput {
  readonly documentId: string;
  readonly expectedRevision: number;
  readonly title?: string;
  readonly body?: string;
  readonly permalink?: string;
  readonly sourceUpdatedAt?: string;
}

export interface BrainApplyDeleteInput {
  readonly documentId: string;
  readonly expectedRevision?: number;
}

export type BrainApplyUpsertResult = BrainUpsertDocumentResult | { readonly outcome: "rejected" };

interface NextContent {
  readonly title: string;
  readonly body: string;
  readonly permalink: string;
  readonly provenance: string;
  readonly sourceUpdatedAt: string;
}

const conflict = (): BrainStoreError => new BrainStoreError("conflict");

export function computeBrainContentHash(title: string, body: string): string {
  return createHash("sha256").update(JSON.stringify([title, body])).digest("hex");
}

export function createBrainSourceId(): string {
  return `src_${randomUUID().replaceAll("-", "")}`;
}

export function createBrainReceiptId(): string {
  return `rcp_${randomUUID().replaceAll("-", "")}`;
}

export function brainByteCount(title: string, body: string): number {
  return Buffer.byteLength(title, "utf8") + Buffer.byteLength(body, "utf8");
}

export function tombstoneFields(now: Date) {
  return {
    title: "",
    body: "",
    permalink: "",
    content_hash: computeBrainContentHash("", ""),
    byte_count: 0,
    updated_at: now,
    deleted_at: now,
  };
}

export async function loadCapacity(db: BrainExecutor, scope: BrainScopeKey): Promise<BrainCapacity> {
  const row = await db.selectFrom("brain_documents")
    .select([
      sql<number>`count(*)::int`.as("count"),
      sql<string>`coalesce(sum(byte_count), 0)::bigint`.as("bytes"),
    ])
    .where("owner_id", "=", scope.ownerId)
    .where("scope_id", "=", scope.scopeId)
    .executeTakeFirstOrThrow();
  return { count: Number(row.count), bytes: Number(row.bytes) };
}

async function loadDocumentForUpdate(
  db: BrainExecutor,
  scope: BrainScopeKey,
  documentId: string,
): Promise<BrainDocumentRow | undefined> {
  return db.selectFrom("brain_documents").selectAll()
    .where("owner_id", "=", scope.ownerId)
    .where("scope_id", "=", scope.scopeId)
    .where("document_id", "=", documentId)
    .forUpdate()
    .executeTakeFirst();
}

/** Snapshots the current live state, then keeps only the newest BRAIN_REVISIONS_PER_DOCUMENT rows. */
export async function snapshotAndPrune(
  db: BrainExecutor,
  row: BrainDocumentRow,
  change: BrainDocumentChange,
  now: Date,
): Promise<void> {
  await db.insertInto("brain_document_revisions").values({
    owner_id: row.owner_id,
    scope_id: row.scope_id,
    document_id: row.document_id,
    source_id: row.source_id,
    incarnation: row.incarnation,
    revision: row.revision,
    change,
    title: row.title,
    body: row.body,
    permalink: row.permalink,
    content_hash: row.content_hash,
    byte_count: row.byte_count,
    provenance: row.provenance,
    source_updated_at: row.source_updated_at,
    superseded_at: now,
  }).execute();
  await sql`
    DELETE FROM brain_document_revisions WHERE ctid IN (
      SELECT ctid FROM brain_document_revisions
      WHERE owner_id = ${row.owner_id} AND scope_id = ${row.scope_id} AND document_id = ${row.document_id}
      ORDER BY superseded_at DESC, revision DESC
      OFFSET ${BRAIN_REVISIONS_PER_DOCUMENT}
    )
  `.execute(db);
}

function assertByteCapacity(context: BrainWriteContext, previousBytes: number, nextBytes: number): void {
  if (context.capacity.bytes - previousBytes + nextBytes > context.limits.maxBytesPerScope) {
    throw new BrainStoreError("capacity");
  }
}

/** Snapshot, prune, then CAS-update the live row to the next content at revision + 1. */
async function replaceLiveRow(
  context: BrainWriteContext,
  row: BrainDocumentRow,
  next: NextContent,
): Promise<BrainDocumentRow> {
  await snapshotAndPrune(context.db, row, "updated", context.now);
  const updated = await context.db.updateTable("brain_documents").set({
    title: next.title,
    body: next.body,
    permalink: next.permalink,
    content_hash: computeBrainContentHash(next.title, next.body),
    byte_count: brainByteCount(next.title, next.body),
    provenance: next.provenance,
    source_updated_at: next.sourceUpdatedAt,
    updated_at: context.now,
    revision: row.revision + 1,
  })
    .where("owner_id", "=", row.owner_id)
    .where("scope_id", "=", row.scope_id)
    .where("document_id", "=", row.document_id)
    .where("revision", "=", row.revision)
    .where("deleted_at", "is", null)
    .returningAll()
    .executeTakeFirstOrThrow(conflict);
  context.capacity.bytes += updated.byte_count - row.byte_count;
  return updated;
}

/** Revives a tombstone or inserts a new row; both start a fresh incarnation at revision 1. */
async function createLiveRow(
  context: BrainWriteContext,
  row: BrainDocumentRow | undefined,
  input: BrainApplyUpsertInput,
  contentHash: string,
  byteCount: number,
): Promise<BrainDocumentRow> {
  const { db, scope, now } = context;
  const liveFields = {
    source_id: input.sourceId,
    incarnation: randomUUID(),
    title: input.title,
    body: input.body,
    permalink: input.permalink,
    content_hash: contentHash,
    byte_count: byteCount,
    provenance: input.provenance,
    revision: 1,
    source_updated_at: input.sourceUpdatedAt,
    published_at: now,
    updated_at: now,
    deleted_at: null,
  };
  if (row) {
    return db.updateTable("brain_documents").set(liveFields)
      .where("owner_id", "=", scope.ownerId)
      .where("scope_id", "=", scope.scopeId)
      .where("document_id", "=", input.documentId)
      .where("deleted_at", "is not", null)
      .returningAll()
      .executeTakeFirstOrThrow(conflict);
  }
  const inserted = await db.insertInto("brain_documents")
    .values({ owner_id: scope.ownerId, scope_id: scope.scopeId, document_id: input.documentId, ...liveFields })
    .onConflict((oc) => oc.columns(["owner_id", "scope_id", "document_id"]).doNothing())
    .returningAll()
    .executeTakeFirstOrThrow(conflict);
  context.capacity.count += 1;
  return inserted;
}

export async function applyUpsert(
  context: BrainWriteContext,
  input: BrainApplyUpsertInput,
  options: { readonly onForeignSource: "conflict" },
): Promise<BrainUpsertDocumentResult>;
export async function applyUpsert(
  context: BrainWriteContext,
  input: BrainApplyUpsertInput,
  options: { readonly onForeignSource: "reject" },
): Promise<BrainApplyUpsertResult>;
export async function applyUpsert(
  context: BrainWriteContext,
  input: BrainApplyUpsertInput,
  options: { readonly onForeignSource: "conflict" | "reject" },
): Promise<BrainApplyUpsertResult> {
  const row = await loadDocumentForUpdate(context.db, context.scope, input.documentId);
  const live = row !== undefined && row.deleted_at === null ? row : null;
  if (input.expectedRevision === 0 && live) throw conflict();
  if (input.expectedRevision !== undefined && input.expectedRevision > 0
    && (!live || live.revision !== input.expectedRevision)) {
    throw conflict();
  }
  if (live && live.source_id !== input.sourceId) {
    if (options.onForeignSource === "reject") return { outcome: "rejected" };
    throw conflict();
  }
  const contentHash = computeBrainContentHash(input.title, input.body);
  if (live && live.content_hash === contentHash && live.permalink === input.permalink) {
    return { outcome: "unchanged", document: toBrainDocument(live) };
  }
  const byteCount = brainByteCount(input.title, input.body);
  if (!row && context.capacity.count >= context.limits.maxDocumentsPerScope) {
    throw new BrainStoreError("capacity");
  }
  assertByteCapacity(context, live ? live.byte_count : 0, byteCount);
  if (live) {
    return { outcome: "updated", document: toBrainDocument(await replaceLiveRow(context, live, input)) };
  }
  const created = await createLiveRow(context, row, input, contentHash, byteCount);
  context.capacity.bytes += byteCount;
  return { outcome: "created", document: toBrainDocument(created) };
}

/**
 * Sync batches only: an unchanged document still takes the source's newest stamp, so an adapter that compares stamps
 * does not rebuild it on every run. Content, revision, snapshots and updated_at stay as they are. Returns whether
 * it wrote (derived indexes that carry the date must be told).
 */
export async function recordSourceUpdatedAt(
  context: BrainWriteContext,
  document: BrainDocument,
  sourceUpdatedAt: string,
): Promise<boolean> {
  if (Date.parse(document.sourceUpdatedAt) === Date.parse(sourceUpdatedAt)) return false;
  await context.db.updateTable("brain_documents").set({ source_updated_at: sourceUpdatedAt })
    .where("owner_id", "=", context.scope.ownerId)
    .where("scope_id", "=", context.scope.scopeId)
    .where("document_id", "=", document.documentId)
    .where("revision", "=", document.revision)
    .where("deleted_at", "is", null)
    .returning("document_id")
    .executeTakeFirstOrThrow(conflict);
  return true;
}

export async function applyRevise(context: BrainWriteContext, input: BrainApplyReviseInput): Promise<BrainDocument> {
  const row = await loadDocumentForUpdate(context.db, context.scope, input.documentId);
  if (!row || row.deleted_at !== null) throw new BrainStoreError("not_found");
  if (row.revision !== input.expectedRevision) throw conflict();
  const next: NextContent = {
    title: input.title ?? row.title,
    body: input.body ?? row.body,
    permalink: input.permalink ?? row.permalink,
    provenance: row.provenance,
    sourceUpdatedAt: input.sourceUpdatedAt ?? new Date(row.source_updated_at).toISOString(),
  };
  const byteCount = brainByteCount(next.title, next.body);
  if (byteCount > BRAIN_DOCUMENT_MAX_BYTES) throw new BrainStoreError("invalid");
  assertByteCapacity(context, row.byte_count, byteCount);
  return toBrainDocument(await replaceLiveRow(context, row, next));
}

/**
 * Tombstones one live document. With `ownedBySourceId`, a missing, tombstoned
 * or foreign-source row is skipped (returns null) so sync replays stay idempotent.
 */
export async function applyDelete(context: BrainWriteContext, input: BrainApplyDeleteInput): Promise<BrainDocument>;
export async function applyDelete(
  context: BrainWriteContext,
  input: BrainApplyDeleteInput,
  options: { readonly ownedBySourceId: string },
): Promise<BrainDocument | null>;
export async function applyDelete(
  context: BrainWriteContext,
  input: BrainApplyDeleteInput,
  options: { readonly ownedBySourceId?: string } = {},
): Promise<BrainDocument | null> {
  const { db, scope, now } = context;
  const row = await loadDocumentForUpdate(db, scope, input.documentId);
  const skippable = options.ownedBySourceId !== undefined;
  if (!row || row.deleted_at !== null) {
    if (skippable) return null;
    throw new BrainStoreError("not_found");
  }
  if (skippable && row.source_id !== options.ownedBySourceId) return null;
  if (input.expectedRevision !== undefined && row.revision !== input.expectedRevision) throw conflict();
  await snapshotAndPrune(db, row, "deleted", now);
  const tombstone = await db.updateTable("brain_documents")
    .set({ ...tombstoneFields(now), revision: row.revision + 1 })
    .where("owner_id", "=", scope.ownerId)
    .where("scope_id", "=", scope.scopeId)
    .where("document_id", "=", input.documentId)
    .where("revision", "=", row.revision)
    .where("deleted_at", "is", null)
    .returningAll()
    .executeTakeFirstOrThrow(conflict);
  await deleteDocumentRefs(db, scope, input.documentId);
  await deleteClaimData(db, scope, { documentId: input.documentId });
  context.capacity.bytes -= row.byte_count;
  return toBrainDocument(tombstone);
}
