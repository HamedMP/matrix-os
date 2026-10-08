/**
 * Company Brain repository: the only reader and writer of the brain_* tables.
 * The caller resolves and authorizes a BrainScopeKey; this class never
 * authorizes. Every method parses its inputs first; every write runs in one
 * transaction under a per-scope advisory lock with bounded deadlines.
 * Postgres errors propagate unchanged; BrainStoreError codes cover the rest.
 */
import { Kysely, sql, type Dialect, type Transaction } from "kysely";
import { selectClaims } from "./claims/reads.js";
import {
  BrainApplyDocumentExtractionSchema, BrainClaimListQuerySchema, BrainCloseExtractionRunSchema,
  BrainOpenExtractionRunSchema, BrainPendingExtractionQuerySchema,
} from "./claims/schemas.js";
import { selectBrainModelSpend } from "./claims/spend.js";
import { applyExtraction, closeRun, openRun, retireBilledRuns, selectPendingExtractions } from "./claims/store.js";
import {
  BRAIN_CLAIMS_PER_SCOPE_MAX, type BrainApplyDocumentExtractionInput, type BrainApplyDocumentExtractionResult,
  type BrainClaimListQuery, type BrainClaimPage, type BrainClaimReader, type BrainCloseExtractionRunInput,
  type BrainExtractionRun, type BrainExtractionStore, type BrainModelSpendTotal, type BrainPendingExtractionPage,
  type BrainPendingExtractionQuery,
} from "./claims/types.js";
import { bootstrapBrainDatabase } from "./database.js";
import {
  assertProofsCurrent,
  listDocumentRevisions,
  listDocumentSummaries,
  readDocument,
  searchDocumentSummaries,
} from "./document-reads.js";
import { selectDocumentRefs, syncDocumentRefs } from "./document-refs.js";
import {
  applyDelete,
  applyRevise,
  applyUpsert,
  loadCapacity,
  recordSourceUpdatedAt,
  type BrainCapacityLimits,
  type BrainWriteContext,
} from "./documents.js";
import {
  BrainCloseSyncReceiptSchema,
  BrainCreateSourceSchema,
  BrainDeleteDocumentSchema,
  BrainDeleteSourceSchema,
  BrainDocumentIdSchema,
  BrainEvidenceProofsSchema,
  BrainListDocumentsOptionsSchema,
  BrainListOptionsSchema,
  BrainListReceiptsOptionsSchema,
  BrainOpenSyncReceiptSchema,
  BrainRefMatchQuerySchema,
  BrainReviseDocumentSchema,
  BrainScopeKeySchema,
  BrainSearchSchema,
  BrainSourceIdSchema,
  BrainSyncBatchSchema,
  BrainUpdateSourceSchema,
  BrainUpsertDocumentSchema,
  parseBrainInput,
} from "./schemas.js";
import { toBrainSource, toBrainSyncCursor } from "./mappers.js";
import { selectDocumentsByRef } from "./refs-reads.js";
import {
  insertSource,
  listSourcePage,
  requireActiveSource,
  selectLiveSource,
  tombstoneSource,
  updateSourceRow,
} from "./sources.js";
import { advanceCursor, closeReceipt, listReceipts, openReceipt, selectCursor } from "./sync.js";
import {
  BRAIN_DEFAULT_MAX_BYTES_PER_SCOPE,
  BRAIN_DEFAULT_MAX_DOCUMENTS_PER_SCOPE,
  BRAIN_MAX_DOCUMENTS_PER_SCOPE_CEILING,
  BrainStoreError,
  type BrainCloseSyncReceiptInput,
  type BrainCreateSourceInput,
  type BrainCreateSourceResult,
  type BrainDatabase,
  type BrainDeleteDocumentInput,
  type BrainDeleteSourceInput,
  type BrainDocument,
  type BrainDocumentRef,
  type BrainDocumentRevision,
  type BrainDocumentSummary,
  type BrainEvidenceProof,
  type BrainListDocumentsOptions,
  type BrainListOptions,
  type BrainOpenSyncReceiptInput,
  type BrainPage,
  type BrainRefMatchPage,
  type BrainRefMatchQuery,
  type BrainRepositoryOptions,
  type BrainReviseDocumentInput,
  type BrainScopeKey,
  type BrainSearchInput,
  type BrainSource,
  type BrainSyncBatchInput,
  type BrainSyncBatchResult,
  type BrainSyncCursor,
  type BrainSyncReceipt,
  type BrainUpdateSourceInput,
  type BrainUpsertDocumentInput,
  type BrainUpsertDocumentResult,
} from "./types.js";

/**
 * Bytes per scope have no product ceiling: an operator raising the budget gets
 * exactly what they configured. (A `BRAIN_MAX_BYTES_PER_SCOPE_CEILING` in
 * types.ts would be the cleaner home for this value.)
 */
const MAX_BYTES_PER_SCOPE_CEILING = Number.MAX_SAFE_INTEGER;

function clampLimit(value: number | undefined, fallback: number, ceiling: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(ceiling, Math.max(1, Math.floor(value)));
}

export class BrainRepository implements BrainExtractionStore, BrainClaimReader {
  readonly kysely: Kysely<BrainDatabase>;
  private readonly ownsConnection: boolean;
  private readonly now: () => Date;
  private readonly limits: BrainCapacityLimits;
  private readonly maxClaimsPerScope: number;

  /** A Dialect is owned (and destroyed) here; a shared Kysely is never destroyed here. */
  constructor(dialectOrKysely: Dialect | Kysely<BrainDatabase>, options: BrainRepositoryOptions = {}) {
    if (dialectOrKysely instanceof Kysely) {
      this.kysely = dialectOrKysely;
      this.ownsConnection = false;
    } else {
      this.kysely = new Kysely<BrainDatabase>({ dialect: dialectOrKysely });
      this.ownsConnection = true;
    }
    this.now = options.now ?? (() => new Date());
    this.limits = {
      maxDocumentsPerScope: clampLimit(
        options.maxDocumentsPerScope, BRAIN_DEFAULT_MAX_DOCUMENTS_PER_SCOPE, BRAIN_MAX_DOCUMENTS_PER_SCOPE_CEILING,
      ),
      maxBytesPerScope: clampLimit(
        options.maxBytesPerScope, BRAIN_DEFAULT_MAX_BYTES_PER_SCOPE, MAX_BYTES_PER_SCOPE_CEILING,
      ),
    };
    this.maxClaimsPerScope = clampLimit(options.maxClaimsPerScope, BRAIN_CLAIMS_PER_SCOPE_MAX, BRAIN_CLAIMS_PER_SCOPE_MAX);
  }

  async bootstrap(): Promise<void> {
    await bootstrapBrainDatabase(this.kysely);
  }

  async destroy(): Promise<void> {
    if (this.ownsConnection) await this.kysely.destroy();
  }

  /**
   * One transaction, bounded deadlines, then the per-scope advisory lock. The
   * clock is read only once the lock is held, so a writer that waited on the
   * lock never commits an older timestamp than the writer that released it:
   * updated_at / superseded_at / started_at stay monotonic within a scope.
   */
  private withScopeWrite<T>(
    scope: BrainScopeKey,
    fn: (trx: Transaction<BrainDatabase>, now: Date) => Promise<T>,
  ): Promise<T> {
    return this.kysely.transaction().execute(async (trx) => {
      await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
      await sql`SET LOCAL statement_timeout = '15s'`.execute(trx);
      await sql`SELECT pg_advisory_xact_lock(hashtext(${scope.ownerId}), hashtext(${`brain:${scope.scopeId}`}))`.execute(trx);
      return fn(trx, this.now());
    });
  }

  private async writeContext(trx: Transaction<BrainDatabase>, scope: BrainScopeKey, now: Date): Promise<BrainWriteContext> {
    return { db: trx, scope, now, limits: this.limits, capacity: await loadCapacity(trx, scope) };
  }

  // Sources

  async createSource(scope: BrainScopeKey, input: BrainCreateSourceInput): Promise<BrainCreateSourceResult> {
    const key = parseBrainInput(BrainScopeKeySchema, scope);
    const source = parseBrainInput(BrainCreateSourceSchema, input);
    return this.withScopeWrite(key, (trx, now) => insertSource(trx, key, source, now));
  }

  async getSource(scope: BrainScopeKey, sourceId: string): Promise<BrainSource | null> {
    const key = parseBrainInput(BrainScopeKeySchema, scope);
    const row = await selectLiveSource(this.kysely, key, parseBrainInput(BrainSourceIdSchema, sourceId));
    return row ? toBrainSource(row) : null;
  }

  async listSources(scope: BrainScopeKey, options: BrainListOptions = {}): Promise<BrainPage<BrainSource>> {
    const key = parseBrainInput(BrainScopeKeySchema, scope);
    return listSourcePage(this.kysely, key, parseBrainInput(BrainListOptionsSchema, options));
  }

  async updateSource(scope: BrainScopeKey, input: BrainUpdateSourceInput): Promise<BrainSource> {
    const key = parseBrainInput(BrainScopeKeySchema, scope);
    const patch = parseBrainInput(BrainUpdateSourceSchema, input);
    return this.withScopeWrite(key, (trx, now) => updateSourceRow(trx, key, patch, now));
  }

  /**
   * Tombstones the source and removes its documents' content, history and
   * cursor; a running receipt is closed as interrupted and receipts stay.
   */
  async deleteSource(scope: BrainScopeKey, input: BrainDeleteSourceInput): Promise<BrainSource> {
    const key = parseBrainInput(BrainScopeKeySchema, scope);
    const target = parseBrainInput(BrainDeleteSourceSchema, input);
    return this.withScopeWrite(key, (trx, now) => tombstoneSource(trx, key, target, now));
  }

  // Documents

  async upsertDocument(scope: BrainScopeKey, input: BrainUpsertDocumentInput): Promise<BrainUpsertDocumentResult> {
    const key = parseBrainInput(BrainScopeKeySchema, scope);
    const document = parseBrainInput(BrainUpsertDocumentSchema, input);
    return this.withScopeWrite(key, async (trx, now) => {
      if (document.sourceId !== null && !(await selectLiveSource(trx, key, document.sourceId))) {
        throw new BrainStoreError("not_found");
      }
      return applyUpsert(await this.writeContext(trx, key, now), document, { onForeignSource: "conflict" });
    });
  }

  async reviseDocument(scope: BrainScopeKey, input: BrainReviseDocumentInput): Promise<BrainDocument> {
    const key = parseBrainInput(BrainScopeKeySchema, scope);
    const patch = parseBrainInput(BrainReviseDocumentSchema, input);
    return this.withScopeWrite(key, async (trx, now) => applyRevise(await this.writeContext(trx, key, now), patch));
  }

  async deleteDocument(scope: BrainScopeKey, input: BrainDeleteDocumentInput): Promise<BrainDocument> {
    const key = parseBrainInput(BrainScopeKeySchema, scope);
    const target = parseBrainInput(BrainDeleteDocumentSchema, input);
    return this.withScopeWrite(key, async (trx, now) => applyDelete(await this.writeContext(trx, key, now), target));
  }

  async getDocument(scope: BrainScopeKey, documentId: string): Promise<BrainDocument | null> {
    const key = parseBrainInput(BrainScopeKeySchema, scope);
    return readDocument(this.kysely, key, parseBrainInput(BrainDocumentIdSchema, documentId));
  }

  async listDocuments(
    scope: BrainScopeKey,
    options: BrainListDocumentsOptions = {},
  ): Promise<BrainPage<BrainDocumentSummary>> {
    const key = parseBrainInput(BrainScopeKeySchema, scope);
    return listDocumentSummaries(this.kysely, key, parseBrainInput(BrainListDocumentsOptionsSchema, options));
  }

  async searchDocuments(scope: BrainScopeKey, input: BrainSearchInput): Promise<readonly BrainDocumentSummary[]> {
    const key = parseBrainInput(BrainScopeKeySchema, scope);
    return searchDocumentSummaries(this.kysely, key, parseBrainInput(BrainSearchSchema, input));
  }

  async listRevisions(scope: BrainScopeKey, documentId: string): Promise<readonly BrainDocumentRevision[]> {
    const key = parseBrainInput(BrainScopeKeySchema, scope);
    return listDocumentRevisions(this.kysely, key, parseBrainInput(BrainDocumentIdSchema, documentId));
  }

  /** At most BRAIN_DOCUMENT_REFS_MAX refs, ordered by kind then value; empty for missing or tombstoned. */
  async listDocumentRefs(scope: BrainScopeKey, documentId: string): Promise<readonly BrainDocumentRef[]> {
    const key = parseBrainInput(BrainScopeKeySchema, scope);
    return selectDocumentRefs(this.kysely, key, parseBrainInput(BrainDocumentIdSchema, documentId));
  }

  /** Live documents with a `kind` ref equal to or under `value`, newest source_updated_at first, keyset paged. */
  async listDocumentsByRef(scope: BrainScopeKey, query: BrainRefMatchQuery): Promise<BrainRefMatchPage> {
    const key = parseBrainInput(BrainScopeKeySchema, scope);
    return selectDocumentsByRef(this.kysely, key, parseBrainInput(BrainRefMatchQuerySchema, query));
  }

  async assertCurrent(scope: BrainScopeKey, proofs: readonly BrainEvidenceProof[]): Promise<void> {
    const key = parseBrainInput(BrainScopeKeySchema, scope);
    await assertProofsCurrent(this.kysely, key, parseBrainInput(BrainEvidenceProofsSchema, proofs));
  }

  // Sync

  /** Applies one provider page and advances the cursor in the same transaction. */
  async applySyncBatch(scope: BrainScopeKey, input: BrainSyncBatchInput): Promise<BrainSyncBatchResult> {
    const key = parseBrainInput(BrainScopeKeySchema, scope);
    const batch = parseBrainInput(BrainSyncBatchSchema, input);
    return this.withScopeWrite(key, async (trx, now) => {
      await requireActiveSource(trx, key, batch.sourceId);
      const context = await this.writeContext(trx, key, now);
      const counts = { created: 0, updated: 0, unchanged: 0, refsChanged: 0, deleted: 0 };
      const rejected: string[] = [];
      for (const { refs, ...content } of batch.upserts) {
        const result = await applyUpsert(
          context, { ...content, sourceId: batch.sourceId }, { onForeignSource: "reject" },
        );
        if (result.outcome === "rejected") {
          rejected.push(content.documentId);
          continue;
        }
        counts[result.outcome] += 1;
        if (result.outcome === "unchanged") await recordSourceUpdatedAt(context, result.document, content.sourceUpdatedAt);
        const refsChanged = await syncDocumentRefs(trx, key, content.documentId, refs);
        if (refsChanged && result.outcome === "unchanged") counts.refsChanged += 1;
      }
      for (const documentId of batch.deletions) {
        const tombstone = await applyDelete(context, { documentId }, { ownedBySourceId: batch.sourceId });
        if (tombstone) counts.deleted += 1;
      }
      const cursor = await advanceCursor(trx, key, batch, now);
      return { cursor, ...counts, rejected };
    });
  }

  async getSyncCursor(scope: BrainScopeKey, sourceId: string): Promise<BrainSyncCursor | null> {
    const key = parseBrainInput(BrainScopeKeySchema, scope);
    const row = await selectCursor(this.kysely, key, parseBrainInput(BrainSourceIdSchema, sourceId));
    return row ? toBrainSyncCursor(row) : null;
  }

  // Receipts

  async openSyncReceipt(scope: BrainScopeKey, input: BrainOpenSyncReceiptInput): Promise<BrainSyncReceipt> {
    const key = parseBrainInput(BrainScopeKeySchema, scope);
    const target = parseBrainInput(BrainOpenSyncReceiptSchema, input);
    return this.withScopeWrite(key, async (trx, now) => {
      await requireActiveSource(trx, key, target.sourceId);
      return openReceipt(trx, key, target.sourceId, now);
    });
  }

  async closeSyncReceipt(scope: BrainScopeKey, input: BrainCloseSyncReceiptInput): Promise<BrainSyncReceipt> {
    const key = parseBrainInput(BrainScopeKeySchema, scope);
    const close = parseBrainInput(BrainCloseSyncReceiptSchema, input);
    return this.withScopeWrite(key, (trx, now) => closeReceipt(trx, key, close, now));
  }

  async listSyncReceipts(
    scope: BrainScopeKey,
    sourceId: string,
    options: { readonly limit?: number } = {},
  ): Promise<readonly BrainSyncReceipt[]> {
    const key = parseBrainInput(BrainScopeKeySchema, scope);
    const id = parseBrainInput(BrainSourceIdSchema, sourceId);
    const page = parseBrainInput(BrainListReceiptsOptionsSchema, options);
    return listReceipts(this.kysely, key, id, page.limit);
  }

  // Claims (claims/)

  /** Live documents whose extraction state for the extractor is missing, outdated, pending or retryable; no bodies. */
  async listPendingExtractions(
    scope: BrainScopeKey, query: BrainPendingExtractionQuery,
  ): Promise<BrainPendingExtractionPage> {
    const key = parseBrainInput(BrainScopeKeySchema, scope);
    return selectPendingExtractions(this.kysely, key, parseBrainInput(BrainPendingExtractionQuerySchema, query));
  }

  /** Interrupts a running run past its lease; a younger running run is conflict. */
  async openExtractionRun(scope: BrainScopeKey, input: { readonly extractor: string }): Promise<BrainExtractionRun> {
    const key = parseBrainInput(BrainScopeKeySchema, scope);
    const target = parseBrainInput(BrainOpenExtractionRunSchema, input);
    return this.withScopeWrite(key, (trx, now) => openRun(trx, key, target.extractor, now));
  }

  /** Replaces one document's claims for the extractor and records its state, fenced by the running run. */
  async applyDocumentExtraction(
    scope: BrainScopeKey, input: BrainApplyDocumentExtractionInput,
  ): Promise<BrainApplyDocumentExtractionResult> {
    const key = parseBrainInput(BrainScopeKeySchema, scope);
    const apply = parseBrainInput(BrainApplyDocumentExtractionSchema, input);
    return this.withScopeWrite(key, (trx, now) => applyExtraction(trx, key, apply, now, this.maxClaimsPerScope));
  }

  async closeExtractionRun(scope: BrainScopeKey, input: BrainCloseExtractionRunInput): Promise<BrainExtractionRun> {
    const key = parseBrainInput(BrainScopeKeySchema, scope);
    const close = parseBrainInput(BrainCloseExtractionRunSchema, input);
    return this.withScopeWrite(key, (trx, now) => closeRun(trx, key, close, now));
  }

  /** Model spend of the owner's runs (every scope) started in the last 30 days, by the repository clock; no lock. */
  async readModelSpend(scope: BrainScopeKey): Promise<BrainModelSpendTotal> {
    return selectBrainModelSpend(this.kysely, parseBrainInput(BrainScopeKeySchema, scope), this.now());
  }

  /** Claims of live documents, newest first, keyset paged; stale when the document moved past the claim's revision. */
  async listClaims(scope: BrainScopeKey, query: BrainClaimListQuery): Promise<BrainClaimPage> {
    const key = parseBrainInput(BrainScopeKeySchema, scope);
    return selectClaims(this.kysely, key, parseBrainInput(BrainClaimListQuerySchema, query));
  }

  // Erase

  /**
   * Physically removes every row of the scope; frees capacity and incarnations. The scope's billed extraction runs
   * of the last 30 days are kept apart first (retireBilledRuns), so the owner's model spend cap still counts them.
   */
  async eraseScope(scope: BrainScopeKey): Promise<void> {
    const key = parseBrainInput(BrainScopeKeySchema, scope);
    await this.withScopeWrite(key, async (trx, now) => {
      await retireBilledRuns(trx, key, now);
      for (const table of [
        "brain_claims", "brain_extraction_state", "brain_extraction_runs", "brain_document_refs",
        "brain_document_revisions", "brain_documents", "brain_sync_receipts", "brain_sync_cursors", "brain_sources",
      ] as const) {
        await trx.deleteFrom(table)
          .where("owner_id", "=", key.ownerId)
          .where("scope_id", "=", key.scopeId)
          .execute();
      }
    });
  }
}
