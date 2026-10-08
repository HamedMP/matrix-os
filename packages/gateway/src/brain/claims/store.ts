/**
 * Claim write primitives, run inside BrainRepository.withScopeWrite (per-scope advisory lock). A document's claims for
 * one extractor and its extraction state change together, and only while the named run is the scope's running run. A
 * rules write also removes the document's claims and state of every other rules version, so a document holds at most
 * one rules generation; model rows are never touched by it.
 */
import { randomUUID } from "node:crypto";
import { sql, type Selectable } from "kysely";
import type { BrainExecutor } from "../documents.js";
import { asIso, asNullableIso } from "../mappers.js";
import { BrainStoreError, type BrainScopeKey } from "../types.js";
import type { BrainParsedApplyDocumentExtraction, BrainParsedCloseExtractionRun } from "./schemas.js";
import {
  BRAIN_CLAIMS_PER_DOCUMENT_MAX, BRAIN_EXTRACTION_RUN_LEASE_MS, BRAIN_EXTRACTION_RUNS_PER_SCOPE,
  BRAIN_MODEL_SPEND_WINDOW_MS, BRAIN_RETIRED_RUNS_SCOPE_ID, BRAIN_RULES_EXTRACTOR_PREFIX, isBrainRulesExtractorId,
  type BrainApplyDocumentExtractionResult, type BrainClaimInput, type BrainExtractionRun, type BrainExtractionRunsTable,
  type BrainPendingExtractionPage, type BrainPendingExtractionQuery,
} from "./types.js";

/** Mirrors the attempts CHECK in claims/database.ts. */
const ATTEMPTS_MAX = 1_000;
const CLAIM_DATA_TABLES = ["brain_claims", "brain_extraction_state"] as const;
/** LIKE pattern of every rules extractor id; the prefix holds no wildcard. */
export const BRAIN_RULES_EXTRACTOR_LIKE = `${BRAIN_RULES_EXTRACTOR_PREFIX}%`;

const conflict = (): BrainStoreError => new BrainStoreError("conflict");

export function toBrainExtractionRun(row: Selectable<BrainExtractionRunsTable>): BrainExtractionRun {
  return {
    scopeId: row.scope_id, runId: row.run_id, extractor: row.extractor, status: row.status,
    counts: { documentsProcessed: row.documents_processed, documentsFailed: row.documents_failed,
      claimsWritten: row.claims_written, claimsRemoved: row.claims_removed, claimsRejected: row.claims_rejected,
      quotesRejected: row.quotes_rejected },
    usage: { inputTokens: row.input_tokens, outputTokens: row.output_tokens, costMicroUsd: row.cost_microusd,
      cacheReadTokens: row.cache_read_tokens, cacheWriteTokens: row.cache_write_tokens },
    nextAction: row.next_action, errorCode: row.error_code,
    startedAt: asIso(row.started_at), finishedAt: asNullableIso(row.finished_at),
  };
}

/**
 * Live documents with no state row for the extractor, a row for another (incarnation, revision), a pending row, or a
 * failed row below maxAttempts, of the given provenances only when named. State of another rules version never makes
 * a document done for this one; for a rules extractor, a document that still has such a row is pending too, so a late
 * write by an older gateway is cleared by the next run. Oldest source_updated_at first, or newest first for order
 * "newest" (the brain_documents_recent index fits both); metadata only, never bodies.
 */
export async function selectPendingExtractions(
  db: BrainExecutor, scope: BrainScopeKey, query: BrainPendingExtractionQuery,
): Promise<BrainPendingExtractionPage> {
  const direction = query.order === "newest" ? "desc" : "asc";
  const rows = await db.selectFrom("brain_documents as d")
    .leftJoin("brain_extraction_state as s", (join) => join
      .onRef("s.owner_id", "=", "d.owner_id").onRef("s.scope_id", "=", "d.scope_id")
      .onRef("s.document_id", "=", "d.document_id").on("s.extractor", "=", query.extractor))
    .select(["d.document_id", "d.incarnation", "d.revision", "d.provenance", "d.byte_count", "d.source_updated_at"])
    .where("d.owner_id", "=", scope.ownerId).where("d.scope_id", "=", scope.scopeId).where("d.deleted_at", "is", null)
    .$if(query.provenances !== undefined, (qb) => qb.where("d.provenance", "in", query.provenances!))
    .where((eb) => eb.or([
      eb("s.document_id", "is", null),
      eb("s.incarnation", "<>", eb.ref("d.incarnation")),
      eb("s.revision", "<>", eb.ref("d.revision")),
      eb("s.status", "=", "pending"),
      eb.and([eb("s.status", "=", "failed"), eb("s.attempts", "<", query.maxAttempts)]),
      ...(isBrainRulesExtractorId(query.extractor) ? [eb.exists(eb.selectFrom("brain_extraction_state as o")
        .select("o.document_id").whereRef("o.owner_id", "=", "d.owner_id").whereRef("o.scope_id", "=", "d.scope_id")
        .whereRef("o.document_id", "=", "d.document_id").where("o.extractor", "like", BRAIN_RULES_EXTRACTOR_LIKE)
        .where("o.extractor", "<>", query.extractor))] : []),
    ]))
    .orderBy("d.source_updated_at", direction).orderBy("d.document_id", direction).limit(query.limit + 1).execute();
  return {
    items: rows.slice(0, query.limit).map((row) => ({
      documentId: row.document_id, incarnation: row.incarnation, revision: row.revision, provenance: row.provenance,
      byteCount: row.byte_count, sourceUpdatedAt: asIso(row.source_updated_at),
    })),
    hasMore: rows.length > query.limit,
  };
}

/**
 * Closes a running run older than the lease as interrupted; any other running run is a conflict. The prune keeps the
 * newest finished runs, and every run that cost anything inside the spend window, which spend.ts sums; it also drops
 * the owner's retired runs (retireBilledRuns) once they leave that window.
 */
export async function openRun(
  db: BrainExecutor, scope: BrainScopeKey, extractor: string, now: Date,
): Promise<BrainExtractionRun> {
  await db.updateTable("brain_extraction_runs").set({ status: "interrupted", finished_at: now })
    .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId).where("status", "=", "running")
    .where("started_at", "<=", new Date(now.getTime() - BRAIN_EXTRACTION_RUN_LEASE_MS)).execute();
  const running = await db.selectFrom("brain_extraction_runs").select("run_id")
    .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId).where("status", "=", "running")
    .executeTakeFirst();
  if (running) throw conflict();
  const opened = await db.insertInto("brain_extraction_runs").values({
    owner_id: scope.ownerId, scope_id: scope.scopeId, run_id: `xrn_${randomUUID().replaceAll("-", "")}`, extractor,
    status: "running", error_code: null, started_at: now, finished_at: null,
  }).returningAll().executeTakeFirstOrThrow();
  await sql`
    DELETE FROM brain_extraction_runs WHERE ctid IN (
      SELECT ctid FROM brain_extraction_runs
      WHERE owner_id = ${scope.ownerId} AND scope_id = ${scope.scopeId} AND status <> 'running'
        AND NOT (cost_microusd > 0 AND started_at > ${new Date(now.getTime() - BRAIN_MODEL_SPEND_WINDOW_MS)})
      ORDER BY started_at DESC, run_id DESC
      OFFSET ${BRAIN_EXTRACTION_RUNS_PER_SCOPE - 1}
    )
  `.execute(db);
  await db.deleteFrom("brain_extraction_runs").where("owner_id", "=", scope.ownerId)
    .where("scope_id", "=", BRAIN_RETIRED_RUNS_SCOPE_ID)
    .where("started_at", "<=", new Date(now.getTime() - BRAIN_MODEL_SPEND_WINDOW_MS)).execute();
  return toBrainExtractionRun(opened);
}

/**
 * Part of a scope erase (under its lock): the scope's billed runs inside the spend window move to
 * BRAIN_RETIRED_RUNS_SCOPE_ID (a running one closed as interrupted) instead of being deleted, so the owner's 30-day
 * model spend survives a project erase. Run rows hold counts, usage and codes only, never document text.
 */
export async function retireBilledRuns(db: BrainExecutor, scope: BrainScopeKey, now: Date): Promise<void> {
  await db.updateTable("brain_extraction_runs").set({
    scope_id: BRAIN_RETIRED_RUNS_SCOPE_ID,
    status: sql`CASE WHEN status = 'running' THEN 'interrupted' ELSE status END`,
    finished_at: sql`COALESCE(finished_at, ${now}::timestamptz)`,
  }).where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId).where("cost_microusd", ">", 0)
    .where("started_at", ">", new Date(now.getTime() - BRAIN_MODEL_SPEND_WINDOW_MS)).execute();
}
