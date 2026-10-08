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
